/**
 * Crew Members — one durable, pinned DM thread per crew member.
 *
 * The page realizes the B+C merged design: a member list on the left, the
 * selected member's pinned DM thread in the center (the real chat stack,
 * hosted the way split-view panes host it), and on the right the SAME tabbed
 * side panel the chat page docks — permanent, no close control — whose first
 * tab is the member's Crew summary (read-only observation) and whose + menu
 * offers the chat panel's own views (Files, Artifacts, Terminal, Browser…)
 * against the member's DM slot, because a member thread IS a chat slot.
 * Configuration WRITES are deliberately absent — both Edit affordances
 * navigate to the existing crew manager (/capabilities?tab=crews), so this
 * page never becomes a second editor.
 *
 * Identity is the exact CREW NAME, never the slug: slugification is lossy
 * (`Oncall` and `oncall` share a slug and therefore one thread directory),
 * so rows are keyed and selected by name, and a thread-open response whose
 * `member` is a DIFFERENT name is surfaced as a collision instead of being
 * silently mounted (first-bound-wins is the backend contract).
 *
 * The pin is a server-side property of member slots (born only through
 * POST /api/members/{slug}/thread). It is an invariant of every member
 * thread, so the UI does not announce it — there is no unpinned state to
 * contrast against.
 *
 * Which member is open rides the URL (`?member=<name>`), and the last one
 * opened is remembered per browser: a visit that names no member lands on
 * the remembered one (else the first row), never on the empty column.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Circle, Clock, ExternalLink, Goal, Pause, Pencil, Star, UserPen, UserPlus, Users, Webhook } from 'lucide-react'
import { PanelRightSolid } from '../../components/icons/panels'
import { useTranslation } from 'react-i18next'
import { api, type MemberActivityEntry, type MemberRosterRow, type WebhookTokenEntry } from '../../api/client'
import type { CronJob } from '../../types'
import { wakesCrew, webhookBoundToCrew } from '../../components/crew/wakesCrew'
import {
  AUTONUDGE_LOOPS_QUERY_KEY,
  type AutoNudgeLoop,
  intervalText,
  nextCycle,
} from '../../components/autoNudgeLoop'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { timeAgo } from '../../utils/timeAgo'
import { fmtDateTimeNumeric } from '../../i18n/format'
import { usePersistedBool } from '../../hooks/usePersistedBool'
import { usePersistedString } from '../../hooks/usePersistedString'
import { findReport, type ErrorReport } from '../../utils/errorReport'
import { useAppDispatch, useAppSelector } from '../../store'
import { markSlotRead } from '../../store/dashboardSlice'
import CrewAvatar, { hasAvatarOverride } from '../../components/CrewAvatar'
import CrewStateAvatar from '../../components/CrewStateAvatar'
import CrewAvatarButton from '../../components/crew/CrewAvatarButton'
import ChatPane from '../../components/ChatPane'
import ErrorBoundary from '../../components/ErrorBoundary'
import ErrorNotice from '../../components/ErrorNotice'
import { useIsMobile } from '../../hooks/useIsMobile'
import { SearchInput } from '../../components/ui'
import { AnimatePresence, motion } from 'framer-motion'
import { isSidePanelHidden, shouldMountSidePanel, sidePanelDockMotion } from '../chat/sidePanelMount'
import SidePanel, { SIDE_PANEL_MIN_W, SIDE_PANEL_RESERVED_W, type SidePanelLeadingTab, type SidePanelWithholdable } from '../chat/SidePanel'
import { CHAT_TRANSCRIPT_VIEWS, useAnyLiveAppTab, usePanelTabs, type ViewKind } from '../../hooks/usePanelTabs'
import { usePanelTabDescriptors } from '../../hooks/panelTabRegistry'
import { usePanelDocumentActions } from '../../hooks/usePanelDocumentActions'
import ResizeHandle from '../../components/ResizeHandle'
import { useColumnResize } from '../../hooks/useColumnResize'
import { loadColumnWidth } from '../../lib/columnWidth'
import { compareText } from '../../i18n/format'
import { tabStatus, type TabStatus } from '../../lib/sessionTabs'
import { lastActivityEpoch } from '../chat/sessionOrder'
import { safeGetItem, safeSetItem } from '../../utils/safeStorage'

/** The crew manager surface — the ONLY write path for member configuration.
 *  The explicit tab wins over CapabilitiesPage's remembered last tab. */
const CREW_MANAGER_PATH = '/capabilities?tab=crews'

/** The avatar builder for one member, reached THROUGH the crew manager: the
 *  deep link opens that crew's editor with the builder already up (see
 *  KiroCrewAgentsPage's `?crew=` latch). This page stays read-only — the face
 *  is clickable here, but the write still happens in the one editor. */
const crewAvatarEditPath = (name: string) =>
  `${CREW_MANAGER_PATH}&crew=${encodeURIComponent(name)}&avatar=1`
/** The open member rides the URL (`?member=<name>`) so a reload keeps it
 *  and a link lands on one. Switching members REPLACES the entry — the page
 *  holds one history entry, so Back leaves it in one press (the Sessions
 *  sidebar's rule); only the below-md roster->thread step pushes. The value
 *  is the exact crew NAME, not the slug: the slug is lossy (see the header
 *  comment), and a link that resolved `Oncall` to `oncall`'s thread would be
 *  the silent misroute this page exists to prevent. */
const MEMBER_PARAM = 'member'
/** The last member opened, so returning to the page (or reloading) lands on
 *  the conversation the user left rather than the empty column. Stored by
 *  exact name for the same reason as the URL param. One key per origin is
 *  the right scope: the roster is the gateway's global crew list, and
 *  localStorage is already per-gateway. */
const LAST_MEMBER_KEY = 'mc-members-last-member'

/** Which member to open when the URL names none, or names one that is gone
 *  (deleted or renamed since the link/memory was written): the remembered
 *  member if it is still on the roster, else the first row in display order.
 *  `undefined` only for an empty roster. Pure, so the three cases — default,
 *  restore, stale fallback — are tested directly. */
export function resolveDefaultMember(
  remembered: string | null,
  ordered: readonly MemberRosterRow[],
): MemberRosterRow | undefined {
  if (remembered) {
    const hit = ordered.find((m) => m.name === remembered)
    if (hit) return hit
  }
  return ordered[0]
}

/** Roster width bounds, persisted like the chat sidebar's (mc-sidebar-width). */
const ROSTER_MIN = 200
const ROSTER_MAX = 420
const ROSTER_DEFAULT = 264
const ROSTER_WIDTH_KEY = 'mc-members-roster-width'
/** The permanent first tab of the member's side panel. Its id is what
 *  `usePanelTabs` stores as the strip's focus while it is selected, so it must
 *  not collide with a chat `TabKind` — `'summary'` is the chat page's
 *  session-summary view, a different thing (that one summarises a transcript;
 *  this one describes a member). */
export const CREW_SUMMARY_TAB_ID = 'crew-summary'
/** Chat-panel views this page withholds from the strip and the + menu
 *  (`SidePanel.hiddenViews`). The unfed half is DERIVED, not enumerated: every
 *  view `VIEW_DATA_SOURCE` classifies as `chat-transcript` (Changes / Issues /
 *  Links / Pins today) reads indexes ChatPage builds over the transcript, none
 *  of which runs here, so each would render an affirmative "none" — and a new
 *  transcript-fed view must be classified where kinds are defined before it can
 *  exist, so it cannot arrive here unwithheld. `summary` is the one addition
 *  by choice: the chat page's SESSION summary has data, but next to the "Crew
 *  summary" chip it is an indistinguishable sibling label. Exported so the
 *  test pins the set. */
export const MEMBERS_UNFED_VIEWS: readonly ViewKind[] = [...CHAT_TRANSCRIPT_VIEWS, 'summary']
/** This page's three inter-column gap-2s (24px) — space the side panel must
 *  keep clear beside the roster so a drag can never fold the thread to zero.
 *  The thread's own minimum is already inside the panel's shell reserve
 *  (`SIDE_PANEL_RESERVED_W` budgets the nav rail plus a chat-pane minimum). */
const PANEL_GAPS_W = 24
/** Whether the side panel can sit BESIDE the thread as a permanent column,
 *  or must become an overlay the user opens. Beside needs the shell reserve
 *  (nav rail + a usable thread) plus the live roster width plus the panel's
 *  own minimum — the same arithmetic the chat page's `sidePanelFillWidth` does
 *  for its two columns, with the roster added. Pure, so the boundary is
 *  tested directly. Mobile always overlays (its viewport seats neither). */
export function panelSitsBeside({ winW, rosterW, isMobile }: { winW: number; rosterW: number; isMobile: boolean }): boolean {
  if (isMobile) return false
  return winW - rosterW - PANEL_GAPS_W >= SIDE_PANEL_RESERVED_W + SIDE_PANEL_MIN_W
}
/** Punctuation, not prose: joins an activity label to its project name, and a
 *  driving row's title to its status word in the hover title. */
const PROJECT_SEPARATOR = ' \u00b7 '
/** Driving-sessions rows shown before the list folds behind "Show all". */
const DRIVING_VISIBLE = 5
/** Roster filter persistence — same `mc-` localStorage family as the rest of
 *  the dashboard's view preferences (ChatSidebar's session filters use the
 *  same idiom). Only the TOGGLES live here; the star mark itself is a crew
 *  field on the server. */
const STARRED_ONLY_KEY = 'mc-members-starred-only'
const SOURCE_FILTER_KEY = 'mc-members-source'
/** Source chips. `mine` = crews created in the crew manager (source
 *  'kirocrew'); `builtin` = shipped with Kiro Crew; `package` = written by the
 *  agent sync from installed capability packages — on a busy host the large
 *  majority of the roster, and the reason the filter exists. */
export type MemberSourceFilter = 'all' | 'mine' | 'builtin' | 'package'
const SOURCE_CHIPS: readonly Exclude<MemberSourceFilter, 'all'>[] = ['mine', 'builtin', 'package']
/** Static key per chip — a map, not a template, so `check-i18n-keys` can
 *  resolve every reference (assembled keys are a counted blind spot there). */
const SOURCE_CHIP_LABEL_KEY: Record<Exclude<MemberSourceFilter, 'all'>, string> = {
  mine: 'pages.membersPage.filter_source_mine',
  builtin: 'pages.membersPage.filter_source_builtin',
  package: 'pages.membersPage.filter_source_package',
}
/** Hover tooltip per chip: the one-word labels ("From packages") are not
 *  self-explaining to a reader who has never installed a capability package. */
const SOURCE_CHIP_TITLE_KEY: Record<Exclude<MemberSourceFilter, 'all'>, string> = {
  mine: 'pages.membersPage.filter_source_mine_description',
  builtin: 'pages.membersPage.filter_source_builtin_description',
  package: 'pages.membersPage.filter_source_package_description',
}
export function parseSourceFilter(raw: string | null): MemberSourceFilter {
  return raw === 'mine' || raw === 'builtin' || raw === 'package' ? raw : 'all'
}
/** The server normalizes `source` to kirocrew | builtin | package before it
 *  reaches the wire; the fallback-to-package here only covers a row from an
 *  older gateway that omits the field. */
export function matchesSource(m: { source?: unknown }, f: MemberSourceFilter): boolean {
  if (f === 'all') return true
  const src = typeof m.source === 'string' ? m.source : ''
  if (f === 'mine') return src === 'kirocrew'
  if (f === 'builtin') return src === 'builtin'
  return src !== 'kirocrew' && src !== 'builtin'
}
/** How each shared tab status renders on a driving row. The ORDER lives in
 *  `tabStatus` (lib/sessionTabs.ts) — this only maps its verdict to a dot
 *  class, an i18n label, and whether the label is spoken aloud in the row.
 *  `unread` cannot occur here (no unread set is passed) and reads as idle. */
const DRIVING_STATUS: Record<TabStatus, { cls: string; text: string; label: string; spoken: boolean }> = {
  permission: { cls: 'fill-warn text-warn', text: 'text-warn', label: 'pages.chatSidebar.needs_approval', spoken: true },
  question: { cls: 'fill-info text-info', text: 'text-info', label: 'pages.chatSidebar.needs_your_answer', spoken: true },
  running: { cls: 'fill-ok text-ok', text: 'text-ok', label: 'pages.membersPage.drawer_working', spoken: false },
  unread: { cls: 'fill-muted text-muted', text: 'text-muted', label: 'pages.membersPage.driving_idle', spoken: false },
  idle: { cls: 'fill-muted text-muted', text: 'text-muted', label: 'pages.membersPage.driving_idle', spoken: false },
}
// Module-level so the resize hook's memoised resolver isn't invalidated every render.
const loadRosterWidth = () => loadColumnWidth(ROSTER_WIDTH_KEY, ROSTER_MIN, ROSTER_MAX, ROSTER_DEFAULT)
/** The chat side panel's right-dock mount preset — module-pure, so one
 *  constant serves every render. */
const dockMotion = sidePanelDockMotion('right')
/** The auto-nudge service's terminal codes (`NudgeLoop.stopped_reason`) a
 *  member slot can actually receive, each mapped to the sentence the patrol
 *  block shows for a stopped loop. A code not listed here — a future terminal
 *  condition, or `autonudge_stop`, which today only research loops are
 *  stamped with — falls back to the code itself rather than to a sentence
 *  nothing produces. */
const PATROL_STOPPED_REASON: Record<string, string> = {
  manual: 'pages.membersPage.patrol_stopped_manual',
  cycle_cap: 'pages.membersPage.patrol_stopped_cycle_cap',
  runtime_budget: 'pages.membersPage.patrol_stopped_runtime_budget',
  approval_stalled: 'pages.membersPage.patrol_stopped_approval_stalled',
}
/** Floor under the websocket-driven invalidation of the loop registry: frames
 *  fire only on change, so a frame lost to a dropped socket would otherwise
 *  leave a stale verdict on screen indefinitely. One minute bounds that. */
const PATROL_REFRESH_MS = 60_000
/** How often the "next wake in …" countdown in the drawer re-reads the clock.
 *  Coarser than the popover's per-second tick on purpose: the drawer line is
 *  an at-a-glance status, and a per-second re-render of the whole drawer for
 *  a readout that already drops seconds above a minute buys nothing. */
const PATROL_TICK_MS = 15_000

export default function MembersPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const [members, setMembers] = useState<MemberRosterRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(false)
  // Identity is the exact crew name (unique in the registry); the slug is not.
  const [activeName, setActiveName] = useState<string>('')
  // The URL is the one source of WHICH member is open; activeName follows it
  // (sync effect below). Clicks write the URL, never activeName directly, so
  // the phone's back gesture, a reload and a shallow link go through the same
  // path as a click.
  const [searchParams, setSearchParams] = useSearchParams()
  const urlMember = searchParams.get(MEMBER_PARAM) ?? ''
  // Set when a URL NAMED a member that is gone: the user asked for someone
  // specific, so the outcome is said out loud — above the fallback thread on
  // md+ (`shown` = who opened instead), above the roster below md (`shown` is
  // '' — no thread opened). The remembered-member fallback never sets it —
  // there the user named nobody. Cleared once a different member opens.
  const [gone, setGone] = useState<{ name: string; shown: string } | null>(null)
  // The member the fallback is about to open in place of a gone one a link
  // named. Set right before the fallback's URL write, read (and cleared) by
  // the open that write triggers, so that open can skip the memory write. A
  // ref, not state: it is a note between two runs of one effect, and must
  // not re-arm it.
  const goneStandInRef = useRef('')
  // name -> slot key / name -> error, filled ONLY by the thread endpoint's
  // response. The roster's `bound`/`slot_key` are never trusted as mountable:
  // dm.json outlives the live slot (a restart drops an unmessaged slot while
  // the binding survives), and mounting an unconfirmed key would let the
  // first message auto-create an ordinary UNPINNED slot on the member key.
  // POST /api/members/{slug}/thread is idempotent and is the only creator/
  // repairer of member slots — so every open goes through it. Keying results
  // by the member they were requested FOR makes a late completion of a
  // previously selected member harmless.
  const [slots, setSlots] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  // The member whose thread POST is IN FLIGHT. While it is, the cached key is
  // only a render hint for the thread column: the side panel must not bind to
  // it, because the POST may come back refusing that very key (renamed /
  // deleted member, a stale binding another session now occupies) and a panel
  // action dispatched in the window — an artifact involvement write, a Side
  // chat turn — cannot be recalled by the unbind that follows.
  const [pendingThreadFor, setPendingThreadFor] = useState('')
  // Sequence of thread POSTs: only the LATEST one may clear the pending mark,
  // so a fast re-click (two POSTs in flight) cannot let the first one's
  // completion re-bind the panel while the second is still unanswered.
  const threadReqSeq = useRef(0)
  // Roster width is user-adjustable on md+ (drag handle on the right edge),
  // mirroring the chat sidebar. Below md the roster is full-width single-pane
  // and the stored width is simply unused. Clamp + persist live in the shared
  // useColumnResize hook — the same primitive every resizable column uses.
  const roster = useColumnResize(ROSTER_WIDTH_KEY, loadRosterWidth, ROSTER_MIN, ROSTER_MAX)
  // Where the side panel lives. Wide enough (see panelSitsBeside) it is a
  // permanent column beside the thread with no close control — the chat page's
  // panel, docked. Narrower, it is an overlay the header button opens and the
  // panel's own close control dismisses, because a column that cannot be
  // dismissed would otherwise fold the thread to nothing. The window width is
  // tracked live (not sampled at mount) so crossing the boundary re-docks.
  const isMobile = useIsMobile()
  const [winW, setWinW] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 0))
  useEffect(() => {
    const onResize = () => setWinW(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const beside = panelSitsBeside({ winW, rosterW: roster.width, isMobile })
  const [overlayOpen, setOverlayOpen] = useState(false)
  // `overlayOpen` is overlay-mode state only. Reset it whenever the panel docks
  // (a widening window, a narrower roster), so an open overlay does not lie in
  // wait and pop back over the thread the moment the window narrows again.
  useEffect(() => { if (beside) setOverlayOpen(false) }, [beside])
  const panelVisible = beside || overlayOpen
  // Live presence rides the already-subscribed WS `slots` frames — the roster
  // endpoint only fills the cold-start gap (its `running` is a snapshot).
  const liveSlots = useAppSelector((s) => s.dashboard.slots)
  // Whether a real slots snapshot has arrived. Before it, an empty `slots` is
  // ambiguous (the store itself refuses to treat a pre-first-frame empty frame
  // as authoritative), so the driving-sessions block must not assert "not
  // driving" on a cold open or a WS reconnect — it shows a skeleton instead,
  // the same three-state discipline the Recent-activity section keeps.
  const slotsLoaded = useAppSelector((s) => s.dashboard.slotsLoaded)
  const liveRunning = useMemo(() => {
    const byKey: Record<string, boolean> = {}
    for (const s of liveSlots) if (s.mode === 'member') byKey[s.key] = !!s.running
    return byKey
  }, [liveSlots])
  const isRunning = useCallback(
    (m: MemberRosterRow) => {
      const key = slots[m.name] || m.slot_key
      return key && key in liveRunning ? liveRunning[key] : m.running
    },
    [slots, liveRunning],
  )

  useEffect(() => {
    let alive = true
    api
      .members()
      .then((r) => {
        if (!alive) return
        setMembers(r.members)
        setLoaded(true)
      })
      .catch(() => {
        if (!alive) return
        setLoadError(true)
        setLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [])

  const active = useMemo(
    () => members.find((m) => m.name === activeName),
    [members, activeName],
  )
  // Most-recently-active first (like any IM member list); never-talked
  // members fall to the bottom alphabetically. Sorted once from the roster
  // snapshot — live re-sorting mid-session would move rows under the cursor.
  const [filter, setFilter] = useState('')
  // Persistent roster filters. The agent sync writes every package-installed
  // agent spec into the roster, so a host with a few dozen installed packages
  // shows dozens of crews the user never drives. Both toggles survive a page
  // change (same localStorage idiom as ChatSidebar's session filters); the
  // star itself is server-side (`starred` on the crew), so it survives a
  // reinstall and follows the config to another dashboard.
  const [starredOnly, setStarredOnly] = usePersistedBool(STARRED_ONLY_KEY, false)
  const [rawSourceFilter, setRawSourceFilter] = usePersistedString(SOURCE_FILTER_KEY, 'all')
  // Storage is hand-editable: an unknown stored value reads as "all".
  const sourceFilter = parseSourceFilter(rawSourceFilter)
  const toggleStarredOnly = useCallback(() => setStarredOnly((prev) => !prev), [setStarredOnly])
  const pickSource = useCallback(
    (next: MemberSourceFilter) => {
      // Clicking the active chip clears it back to "all" — one chip row,
      // no separate reset control.
      setRawSourceFilter((prev) => (parseSourceFilter(prev) === next ? 'all' : next))
    },
    [setRawSourceFilter],
  )
  // Star toggle: optimistic flip, reverted if the PUT fails. The star lives
  // on the crew record, not the DM thread, so it goes through the crew
  // update endpoint rather than a members route. A failed write (403 for a
  // non-owner, 500 on a failed config save) is SURFACED, not just reverted:
  // a star that snaps back with no message reads as a broken button, and
  // AUTOSDE's errors-use-error-notice forbids the silent catch-to-default.
  // Display text is the localized `star_failed` copy; the structured report
  // (endpoint, status, code, detail) is looked up from the thrown message
  // and passed to ErrorNotice explicitly, so the agent hand-off keeps it.
  const [starError, setStarError] = useState<{ message: string; report?: ErrorReport } | null>(null)
  // Names with a star write in flight. The control is disabled while its
  // write is pending, so two rapid toggles cannot race: without this, a
  // second click whose write also fails would revert to the FIRST click's
  // value and leave the row starred while the server is not.
  const [starPending, setStarPending] = useState<Set<string>>(() => new Set())
  const toggleStar = useCallback((m: MemberRosterRow) => {
    const next = !m.starred
    setStarError(null)
    setStarPending((prev) => new Set(prev).add(m.name))
    setMembers((prev) => prev.map((r) => (r.name === m.name ? { ...r, starred: next } : r)))
    api
      .updateKirocrewAgent(m.name, { starred: next })
      .catch((err: unknown) => {
        setMembers((prev) => prev.map((r) => (r.name === m.name ? { ...r, starred: !next } : r)))
        // Localized copy, never the raw server text: the client throws the
        // response body (or `HTTP 500`), which is neither translated nor
        // meant for a user. The journaled report is recovered from that
        // message and handed to ErrorNotice so "Ask the agent" still carries
        // endpoint / status / code / detail.
        setStarError({
          message: t('pages.membersPage.star_failed'),
          report: findReport(err instanceof Error ? err.message : undefined),
        })
      })
      .finally(() => {
        setStarPending((prev) => {
          const n = new Set(prev)
          n.delete(m.name)
          return n
        })
      })
  }, [t])
  const starredCount = useMemo(() => members.filter((m) => !!m.starred).length, [members])
  // Per-bucket counts on the origin chips: the one-word labels do not explain
  // themselves and their tooltips never fire on touch, so each chip shows what
  // it holds instead.
  const sourceCounts = useMemo(() => {
    const out: Record<Exclude<MemberSourceFilter, 'all'>, number> = { mine: 0, builtin: 0, package: 0 }
    for (const m of members) {
      for (const chip of SOURCE_CHIPS) if (matchesSource(m, chip)) out[chip] += 1
    }
    return out
  }, [members])
  // Display order before the search filter — this is what "the first member"
  // means for the default-open below, so a typed filter never changes which
  // member a fresh visit lands on.
  const orderedMembers = useMemo(
    () =>
      [...members].sort(
        (a, b) =>
          (b.last_active_ts ?? 0) - (a.last_active_ts ?? 0) || compareText(a.name, b.name),
      ),
    [members],
  )
  const sortedMembers = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return orderedMembers.filter(
      (m) =>
        (!starredOnly || !!m.starred) &&
        matchesSource(m, sourceFilter) &&
        (!q || m.name.toLowerCase().includes(q)),
    )
  }, [orderedMembers, filter, starredOnly, sourceFilter])
  // True when the filters (not the search) hid everything — the empty-roster
  // copy would be wrong then, since the roster is not empty.
  const filteredOut =
    loaded && !loadError && members.length > 0 && sortedMembers.length === 0 && !filter.trim()
  const activeSlot = active ? slots[active.name] ?? '' : ''
  const activeError = active ? errors[active.name] ?? '' : ''
  // The slot the SIDE PANEL may bind: the cached key only once the CURRENT
  // open's POST has confirmed it. Empty for the whole in-flight window, so no
  // slot-bound view is offered and no document action can record against a
  // key the endpoint is about to refuse. The thread column keeps rendering
  // the cached key meanwhile (its own pre-existing contract).
  const confirmedSlot = active && pendingThreadFor === active.name ? '' : activeSlot

  // Sessions this member is driving: every live slot whose `created_by` is the
  // member's DM slot key. A member dispatches its real work into worker
  // sessions it opens via session_create and steers via session_send, and the
  // backend fences a member caller to the slots it created — so "created by"
  // IS "driven by", and the durable birth attribution is the whole source of
  // truth (no transcript scraping for the `[sent by session …]` prefix). Rides
  // the already-subscribed WS `slots` frames, which is also what gives each row
  // its live status — the same running / needs-approval / needs-input signals
  // the sidebar dot reads. Newest activity first; a closed worker leaves the
  // live slots and therefore this list, which is the honest reading of
  // "driving right now".
  const activeMemberKey = activeSlot || active?.slot_key || ''
  // The side panel's tab strip, bucketed by the member's slot key exactly as
  // the chat page buckets by chat slot: switching members swaps the whole strip
  // and switching back restores it. Keyed on the POST-CONFIRMED `activeSlot`
  // ONLY — never the roster's derived key. That key is a stale binding until
  // the thread endpoint confirms it (see the `slots` comment above): an
  // ordinary slot can occupy the canonical key after a restart, the POST then
  // answers 409 and `activeSlot` stays empty, and a panel bound to the derived
  // key would aim Side chat / Terminal / Summary at that unrelated session.
  // While no confirmed slot exists the strip lives in the shared no-slot bucket
  // and every slot-bound view is withheld (`hiddenViews` below); the Crew
  // summary needs no slot and stays.
  const panelTabDescriptors = usePanelTabDescriptors()
  const tabsCtl = usePanelTabs(activeSlot || null, panelTabDescriptors, { leadingId: CREW_SUMMARY_TAB_ID })
  // The member slot's project directory (the WS slots frame carries it) roots
  // the Files tab and is the cwd a Terminal tab spawns in.
  const activeLiveSlot = useMemo(
    () => (confirmedSlot ? liveSlots.find((s) => s.key === confirmedSlot) : undefined),
    [liveSlots, confirmedSlot],
  )
  const projectDir = activeLiveSlot?.project || undefined
  // Terminal needs the slot RECORD, not just the confirmed key: the thread
  // POST answers before the WS `slots` frame that carries the slot's project,
  // and a shell spawned in that window would take `cwd: undefined` — the
  // backend's HOME fallback — with no re-rooting once the frame lands. Gate on
  // the record being present, not on `project` being set: a member with no
  // project legitimately opens its shell in the fallback cwd, exactly as a
  // project-less chat does.
  const slotRecordPresent = !!activeLiveSlot
  // Views this host withdraws from the strip and the + menu. Always: the views
  // fed by ChatPage-owned transcript indexes (pull-request / issue / link
  // extraction, the pins query) — this page has none of those, and an empty
  // Changes chip on the monitoring page would assert "nothing changed" while a
  // member is editing. `summary` (the chat page's SESSION summary) is withheld
  // too: one click from the "Crew summary" chip, two sibling labels a reader
  // cannot tell apart. Until the thread is confirmed, EVERY slot-bound view is
  // withheld as well, per the binding rule above — and so is Terminal: while
  // unconfirmed the strip sits in the shared no-slot bucket, so a PTY opened
  // then would be orphaned (live shell, unreachable tab) the moment the
  // confirmation re-keys the strip to the member's slot; app-contributed tabs
  // (`'app'`) likewise, since the re-key would remount their `AppHost` and
  // discard the app's own unsaved state. Terminal stays withheld a moment
  // longer — until the WS slots frame carries the confirmed slot, so its cwd
  // is known (see slotRecordPresent).
  const hiddenViews = useMemo<ReadonlySet<SidePanelWithholdable>>(
    () =>
      new Set<SidePanelWithholdable>(
        !confirmedSlot
          ? [...MEMBERS_UNFED_VIEWS, 'files', 'artifacts', 'subagents', 'workflows', 'git', 'side', 'browser', 'logs', 'context', 'terminal', 'app']
          : !slotRecordPresent
            ? [...MEMBERS_UNFED_VIEWS, 'terminal']
            : MEMBERS_UNFED_VIEWS,
      ),
    [confirmedSlot, slotRecordPresent],
  )
  // Whether the Crew summary body is on screen — the gate for its data reads
  // and its countdown tick, so a member whose panel shows a terminal does not
  // pay for a summary nobody is looking at. Read from what the panel SHOWS
  // (`onActiveTabChange`), not from the stored focus: a stored focus on a
  // withheld view falls back to the summary in the strip without moving the
  // store, and the summary must load when it is the one on screen.
  const [shownTabId, setShownTabId] = useState<string | null>(null)
  const summaryVisible = panelVisible && (shownTabId ?? tabsCtl.activeId) === CREW_SUMMARY_TAB_ID
  const closeOverlay = useCallback(() => setOverlayOpen(false), [])
  // Mount continuity — the chat page's rule, verbatim: a live Browser tab (its
  // WebContentsView) or a body-owning app tab (any slot's) cannot survive a
  // remount, so while one exists a closed overlay is kept mounted and hidden
  // rather than unmounted. There is no find pane on this page.
  const hasLiveAppTab = useAnyLiveAppTab()
  const hasBrowserTab = tabsCtl.tabs.some((tab) => tab.kind === 'browser')
  const mountInput = { activityOpen: panelVisible, hasLiveAppTab, hasBrowserTab, searchOpen: false }
  const panelMounted = shouldMountSidePanel(mountInput)
  const panelHidden = isSidePanelHidden(mountInput)
  // File / artifact / save for the panel's Files, Artifacts and document tabs —
  // the chat page's own implementation, not a copy. A failed read is reported
  // above the thread; an open while the panel is an OVERLAY reveals it, since
  // the tab it focused is otherwise hidden behind a closed panel. Docked, the
  // open needs nothing — and must not arm `overlayOpen`, or a later narrowing
  // of the window would find the overlay already open over the thread.
  const queryClient = useQueryClient()
  const activeSlotRef = useRef<string | null>(confirmedSlot || null)
  activeSlotRef.current = confirmedSlot || null
  const besideRef = useRef(beside)
  besideRef.current = beside
  const [actionError, setActionError] = useState('')
  // A failed document read is reported above the thread. In overlay mode the
  // open panel covers exactly that spot — the click that failed happened inside
  // it — so the overlay closes as the notice appears; otherwise the failure is
  // silent to the person who caused it.
  const showActionError = useCallback((message: string) => {
    setActionError(message)
    if (!besideRef.current) setOverlayOpen(false)
  }, [])
  const revealPanelAfterOpen = useCallback(() => { if (!besideRef.current) setOverlayOpen(true) }, [])
  const { openFile, openArtifact, saveFile } = usePanelDocumentActions({
    tabsCtl,
    slotRef: activeSlotRef,
    queryClient,
    showActionError,
    onOpened: revealPanelAfterOpen,
  })
  const drivingSessions = useMemo(() => {
    if (!activeMemberKey) return []
    return liveSlots
      .filter((s) => !!s.created_by && s.created_by === activeMemberKey)
      .sort((a, b) => lastActivityEpoch(b) - lastActivityEpoch(a))
  }, [liveSlots, activeMemberKey])
  // Collapsed past DRIVING_VISIBLE rows. Keyed to the member: the fold is a
  // reading position in ONE member's list, so switching members starts the
  // next list folded rather than inheriting the previous member's expansion.
  const [drivingExpandedFor, setDrivingExpandedFor] = useState('')
  const drivingExpanded = drivingExpandedFor === activeMemberKey
  const visibleDriving = drivingExpanded ? drivingSessions : drivingSessions.slice(0, DRIVING_VISIBLE)

  // Recent-activity pointers for the Crew summary tab, fetched when it is on
  // screen for a member and cached for the page's lifetime. Keyed by the exact member
  // NAME, not the slug — slugs are lossy, and the whole point of the
  // backend's member filter is that two names sharing a slug have distinct
  // histories. Real recorded signal only — the drawer derives its counts
  // from these instead of fabricating stats. Three states per member:
  // absent = still loading, 'error' = fetch failed, object = loaded.
  // A pending or failed read must not render the affirmative "no activity".
  const [activity, setActivity] = useState<
    Record<string, { entries: MemberActivityEntry[]; capped: boolean } | 'error'>
  >({})
  const activeSlug = active?.slug ?? ''
  const activeMemberName = active?.name ?? ''
  useEffect(() => {
    if (!activeSlug || !activeMemberName || !summaryVisible) return
    let cancelled = false
    api
      .memberActivity(activeSlug, activeMemberName)
      .then((r) => {
        if (!cancelled)
          setActivity((prev) => ({
            ...prev,
            [activeMemberName]: { entries: r.entries, capped: !!r.capped },
          }))
      })
      .catch(() => {
        if (!cancelled) setActivity((prev) => ({ ...prev, [activeMemberName]: 'error' }))
      })
    return () => {
      cancelled = true
    }
  }, [activeSlug, activeMemberName, summaryVisible])
  const activityState = activeMemberName ? activity[activeMemberName] : undefined
  const activityLoading = activityState === undefined
  const activityError = activityState === 'error'
  const activeEntries = useMemo(
    () => (typeof activityState === 'object' ? activityState.entries : []),
    [activityState],
  )
  const activityCapped = typeof activityState === 'object' && activityState.capped

  // Wake sources — global lists (crons, webhook tokens, the default crew),
  // fetched ONCE the first time the Crew summary is on screen and filtered per
  // member at render.
  // `failed` is kept distinct from empty: absence of an answer and an answer
  // of "none" must not render the same (a failed fetch would otherwise show
  // the affirmative "nothing wakes this member", a false statement).
  const [wake, setWake] = useState<{
    loaded: boolean
    failed: boolean
    jobs: CronJob[]
    tokens: WebhookTokenEntry[]
    defaultAgent: string
  }>({ loaded: false, failed: false, jobs: [], tokens: [], defaultAgent: '' })
  useEffect(() => {
    if (!summaryVisible || wake.loaded || wake.failed) return
    let cancelled = false
    Promise.all([api.crons(), api.webhooks(), api.kirocrewAgents()])
      .then(([crons, hooks, agents]) => {
        if (cancelled) return
        setWake({
          loaded: true,
          failed: false,
          jobs: crons?.jobs || [],
          tokens: hooks?.tokens || [],
          defaultAgent: agents?.default_agent || '',
        })
      })
      .catch(() => {
        if (!cancelled) setWake((prev) => ({ ...prev, failed: true }))
      })
    return () => {
      cancelled = true
    }
  }, [summaryVisible, wake.loaded, wake.failed])
  const wakeJobs = useMemo(
    () =>
      active
        ? wake.jobs.filter((j) => wakesCrew(j, active.name, active.name === wake.defaultAgent))
        : [],
    [active, wake.jobs, wake.defaultAgent],
  )
  const wakeHooks = useMemo(
    () => (active ? wake.tokens.filter((t) => webhookBoundToCrew(t, active.name)) : []),
    [active, wake.tokens],
  )
  const { todayCount, weekCount, todayFloorTs, weekFloorTs } = useMemo(() => {
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    const todayFloor = midnight.getTime() / 1000
    const weekFloor = Date.now() / 1000 - 7 * 86400
    let today = 0
    let week = 0
    for (const e of activeEntries) {
      if (e.ts >= todayFloor) today += 1
      if (e.ts >= weekFloor) week += 1
    }
    return { todayCount: today, weekCount: week, todayFloorTs: todayFloor, weekFloorTs: weekFloor }
  }, [activeEntries])
  // When the display window is saturated (server capped the entries) AND the
  // oldest returned entry still falls inside a counting window, more in-window
  // events exist beyond the cap — the count is a floor, rendered as "N+"
  // rather than asserted as exact.
  const oldestTs = activeEntries.length ? activeEntries[activeEntries.length - 1].ts : 0
  const todayIsFloor = activityCapped && oldestTs >= todayFloorTs
  const weekIsFloor = activityCapped && oldestTs >= weekFloorTs

  // Mounting a member thread IS reading it, but nothing on this page moves
  // `chat.activeSlot` (that transition belongs to the Sessions page's
  // switchSlot, the only other markSlotRead caller), so the websocket
  // unread-marker keeps flagging this slot even while the user is looking at
  // it. Drain it here instead: once when the thread opens, and again every
  // time a live message re-flags the mounted thread. Without this the rail
  // badge is permanent — no code path clears a live member slot's unread
  // until the slot itself is deleted.
  const dispatch = useAppDispatch()
  const activeSlotUnread = useAppSelector(
    (s) => !!activeSlot && s.dashboard.unreadSlots.includes(activeSlot),
  )
  useEffect(() => {
    if (activeSlot && activeSlotUnread) dispatch(markSlotRead(activeSlot))
  }, [activeSlot, activeSlotUnread, dispatch])

  // Per-row unread marker: the rail badge says "1", this says WHICH member.
  // Keyed the same way isRunning resolves a member's slot (thread-endpoint
  // cache first, roster binding as the cold-start fallback), and read straight
  // from unreadSlots so the drain effect above clears the dot the moment the
  // thread is opened.
  const unreadSlots = useAppSelector((s) => s.dashboard.unreadSlots)
  const isUnread = useCallback(
    (m: MemberRosterRow) => {
      const key = slots[m.name] || m.slot_key
      return !!key && unreadSlots.includes(key)
    },
    [slots, unreadSlots],
  )

  // Auto patrol: the auto-nudge loop (monitor / goal loop) bound to a member's
  // own DM slot. This is the thing that wakes a standing member without anyone
  // asking — so a member whose loop has silently stopped, or never armed, is a
  // member that will not act again until someone notices. The roster badge
  // and the drawer block both read from here, so the whole registry is read
  // (the badge needs every member, not just the open drawer's) and filtered
  // per member at render by slot key — the member's derived slot is
  // `member-<slug>`, resolved the same way isRunning resolves it.
  //
  // One React Query read, not a private fetch + frame merge: the websocket
  // hook invalidates AUTONUDGE_LOOPS_QUERY_KEY on every `autonudge_state`
  // frame AND on every (re)connect, so a stop that landed while the socket was
  // down is re-read the moment it comes back, and a transient mount-time
  // failure is retried on the next signal rather than freezing the block in
  // its failed state. The interval is a floor under that: frames fire only on
  // change, and the one reading this block must never give is a stale
  // "Patrolling" for a dead patrol.
  const patrolQuery = useQuery({
    queryKey: AUTONUDGE_LOOPS_QUERY_KEY,
    queryFn: () => api.autonudgeList(),
    refetchInterval: PATROL_REFRESH_MS,
    refetchOnReconnect: true,
  })
  // `failed` is kept distinct from empty for the same reason the wake-sources
  // block keeps it: a failed read must never render the affirmative "no patrol
  // scheduled", which is precisely the false statement this block exists to
  // prevent. A refetch error after a good read keeps showing the last data.
  const patrol = useMemo(() => {
    const data = patrolQuery.data
    const loops: Record<string, AutoNudgeLoop> = {}
    for (const lp of data?.loops || []) if (lp?.slot_key) loops[lp.slot_key] = lp
    return {
      loaded: data !== undefined || patrolQuery.isError,
      failed: data === undefined && patrolQuery.isError,
      loops,
    }
  }, [patrolQuery.data, patrolQuery.isError])
  const patrolLoopOf = useCallback(
    (m: MemberRosterRow) => {
      const key = slots[m.name] || m.slot_key
      return key ? patrol.loops[key] : undefined
    },
    [slots, patrol.loops],
  )
  /** Roster-level reading of a member's loop record: `active` while it
   *  patrols, `stopped` for a record that went inactive (any reason), and
   *  nothing for a member that never armed one. The stopped state is the
   *  incident's at-a-glance case — a dead patrol must show at the roster,
   *  not only once someone opens the drawer. */
  const patrolBadgeOf = useCallback(
    (m: MemberRosterRow): 'active' | 'stopped' | null => {
      const lp = patrolLoopOf(m)
      return lp ? (lp.active ? 'active' : 'stopped') : null
    },
    [patrolLoopOf],
  )
  const activePatrol = activeMemberKey ? patrol.loops[activeMemberKey] : undefined
  // Which of the block's three verdicts to render. An active loop wins; a
  // stopped loop keeps its reason visible rather than collapsing into
  // "nothing scheduled" — that collapse is exactly how a dead patrol goes
  // unnoticed. (A refused arm is a reserved fourth verdict: the registry
  // contract names the field, but no backend emits it yet, so nothing here
  // renders one.)
  const patrolState: 'active' | 'stopped' | 'none' = activePatrol?.active
    ? 'active'
    : activePatrol
      ? 'stopped'
      : 'none'
  // Clock for the "next wake" countdown, ticking only while the summary shows
  // an active loop — the same deadline-preserving reading the composer's goal
  // chip renders (see nextCycleText), on a coarser tick.
  const [nowTs, setNowTs] = useState(() => Date.now() / 1000)
  const patrolTicking = summaryVisible && patrolState === 'active'
  useEffect(() => {
    if (!patrolTicking) return
    setNowTs(Date.now() / 1000)
    const timer = setInterval(() => setNowTs(Date.now() / 1000), PATROL_TICK_MS)
    return () => clearInterval(timer)
  }, [patrolTicking])

  // Open a member's thread and remember it as the last one opened. Called by
  // the URL sync effect only (plus the same-member re-click below), so every
  // way of arriving at a member — click, back/forward, shallow link, restore
  // on return — runs one code path. `remember` is false only for the member
  // opened IN PLACE OF one a link named that is gone: that open is the page's
  // choice, not the user's, so one stale link must not overwrite the member
  // they had actually chosen.
  const activate = useCallback(
    (m: MemberRosterRow, remember = true) => {
      setActiveName(m.name)
      if (remember) safeSetItem(LAST_MEMBER_KEY, m.name)
      setErrors((prev) => {
        if (!(m.name in prev)) return prev
        const next = { ...prev }
        delete next[m.name]
        return next
      })
      // ALWAYS post, even when a slot key is already cached: the endpoint is
      // the idempotent creator/repairer, and the backend can lose the live
      // slot between opens (archive, restart with a stale binding) — a cached
      // key mounted without the POST would point at nothing. The cache only
      // decides what to render while the POST is in flight — and, for the side
      // panel, not even that (see pendingThreadFor / confirmedSlot).
      setPendingThreadFor(m.name)
      const seq = ++threadReqSeq.current
      // Only the LATEST request may write anything back — pending mark, slot,
      // or error. An older answer arriving after a newer one (a re-click on a
      // slow link, or a switch to another member) is dropped whole: letting a
      // stale success re-bind a key the latest refusal just unbound would aim
      // the panel at a foreign session. Dropping a stale answer loses nothing,
      // because every open re-POSTs.
      const stale = () => threadReqSeq.current !== seq
      const settle = () => setPendingThreadFor((prev) => (prev === m.name ? '' : prev))
      api
        .memberThread(m.slug)
        .then((r) => {
          if (stale()) return
          settle()
          if (r.member !== m.name) {
            // The slug's thread belongs to another crew (lossy-slug collision,
            // first-bound-wins). Mounting it would be a silent misroute — the
            // defining failure for a page whose premise is identity.
            setSlots((prev) => {
              if (!(m.name in prev)) return prev
              const next = { ...prev }
              delete next[m.name]
              return next
            })
            setErrors((prev) => ({
              ...prev,
              [m.name]: t('pages.membersPage.slug_collision', { name: r.member }),
            }))
            return
          }
          setSlots((prev) => ({ ...prev, [m.name]: r.slot_key }))
        })
        .catch(() => {
          if (stale()) return
          settle()
          // A REFUSAL unbinds. The cached key was confirmed by an EARLIER open;
          // a 409 now means the canonical key is occupied by a session that is
          // not this member's (or the endpoint could not repair it), so a
          // cached key kept through the refusal would leave the thread AND
          // every slot-bound panel view (Side chat, Artifacts, Files…) aimed
          // at a foreign session. Drop it: the panel falls back to the
          // slot-free Crew summary and the thread shows the error instead.
          setSlots((prev) => {
            if (!(m.name in prev)) return prev
            const next = { ...prev }
            delete next[m.name]
            return next
          })
          setErrors((prev) => ({
            ...prev,
            [m.name]: t('pages.membersPage.thread_open_failed'),
          }))
        })
    },
    [t],
  )

  const openMember = useCallback(
    (m: MemberRosterRow) => {
      // Re-clicking the open member is the repair gesture (re-POST); the URL
      // is unchanged so the sync effect would not fire — call through. It is
      // also an explicit choice of that member, so a swap notice still
      // standing over it (the user was routed here from a dead link) has
      // been acknowledged: retire it.
      if (m.name === activeName) {
        activate(m)
        setGone(null)
        return
      }
      if (urlMember) {
        // Switching between members while one is open REPLACES the entry, so
        // the page holds one history entry however many members are visited
        // and Back leaves it in one press — the Sessions sidebar's rule.
        setSearchParams({ [MEMBER_PARAM]: m.name }, { replace: true })
        return
      }
      // Entering a thread from the roster (below md, where no member is open)
      // is a step in a two-level navigation, so it is PUSHED. The state marks
      // the entry as pushed from this page's roster, which is what lets the
      // below-md back button pop instead of replace.
      setSearchParams({ [MEMBER_PARAM]: m.name }, { state: { fromRoster: true } })
    },
    [activeName, urlMember, activate, setSearchParams],
  )

  // URL -> open member. Once the roster is in: a URL that names a member
  // opens it; a URL that names none (a fresh visit, the sidebar entry, a
  // reload) is REPLACED with the remembered member, else the first row — so
  // the page never lands on the empty column, and the URL always says what
  // is on screen. A URL naming a member that is gone (deleted or renamed)
  // takes the same fallback, with a one-line notice above the thread naming
  // the swap — the user asked for someone specific, and a silently mounted
  // other thread is the misroute this page exists to prevent. Below md the
  // page is a two-level list->detail navigation: no `?member=` IS the
  // roster, so no auto-open there (same rule as SidePanelLayout's remembered
  // tab), and a gone member in the URL returns to the roster instead of
  // bouncing the phone user into a different member's thread.
  useEffect(() => {
    if (!loaded || loadError) return
    if (urlMember) {
      const hit = members.find((m) => m.name === urlMember)
      if (hit) {
        // Opened in place of a gone member a link named? Then it is not the
        // user's choice and must not become the memory (see `activate`).
        const standIn = goneStandInRef.current === hit.name
        goneStandInRef.current = ''
        if (hit.name !== activeName) activate(hit, !standIn)
        // The notice belongs to the member shown in place of the gone one;
        // opening anyone else retires it. Functional updates throughout, and
        // `gone` is NOT a dependency: the URL write below is a router
        // transition, and a plain state write that re-armed this effect
        // before the transition committed would re-issue both writes and
        // keep interrupting the transition — the thread would never open.
        setGone((prev) => (prev && prev.shown !== hit.name ? null : prev))
        return
      }
    }
    if (isMobile) {
      if (urlMember) {
        // No thread to fall back to below md — the roster is the answer, so
        // say where the member went above the list (shown: '' marks the
        // roster variant of the notice).
        setGone((prev) =>
          prev && prev.name === urlMember && prev.shown === '' ? prev : { name: urlMember, shown: '' },
        )
        setSearchParams({}, { replace: true })
      } else if (activeName) setActiveName('')
      return
    }
    const target = resolveDefaultMember(safeGetItem(LAST_MEMBER_KEY), orderedMembers)
    if (!target) return
    if (urlMember) {
      setGone((prev) =>
        prev && prev.name === urlMember && prev.shown === target.name
          ? prev
          : { name: urlMember, shown: target.name },
      )
      goneStandInRef.current = target.name
    }
    setSearchParams({ [MEMBER_PARAM]: target.name }, { replace: true })
  }, [loaded, loadError, urlMember, members, orderedMembers, activeName, isMobile, activate, setSearchParams])

  return (
    // No bottom inset on the root: the card columns carry their own pb-2 and
    // the side panel brings the chat SidePanel's mb-2, so all three end 8px
    // above the window edge without stacking two insets. No right padding
    // either — the panel docks FLUSH to the window's right edge, exactly as it
    // does in the chat page's actbar column; the card columns' pr-2 lives on
    // the inner wrapper below.
    <div className="flex h-full min-h-0" data-testid="members-page">
      {/* Card columns (roster + thread) keep the page's original insets. */}
      <div className="flex flex-1 min-w-0 gap-2 pr-2 pb-2">
      {/* Member list. Below md the page is single-pane: the roster IS the
          page until a member is picked, then the thread takes over and the
          header's back button returns here. Two fixed rails (264+300px)
          otherwise crush the flex-1 thread to zero at narrow widths.
          Carded like the Sessions page's chat list (ChatSidebar) so the two
          conversation surfaces read as one family. */}
      <aside
        className={`${
          activeName ? 'hidden md:flex' : 'flex'
        } relative w-full md:w-[var(--roster-w)] shrink-0 bg-bg-elevated border border-border rounded-xl shadow-sm flex-col min-h-0`}
        // CSS owns the breakpoint: the var is set unconditionally and only the
        // md: class consumes it, so resizing the window across 768px reacts
        // without any JS media-query snapshot going stale.
        style={{ '--roster-w': `${roster.width}px` } as React.CSSProperties}
        data-testid="member-roster"
      >
        <div className="px-4 pt-4 pb-1 flex items-center gap-2">
          <Users size={15} className="lucide-inline text-muted" />
          <h1 className="text-sm font-semibold flex-1">{t('pages.membersPage.title')}</h1>
          {/* Adding a member IS creating a crew, and the crew manager is the
              only write path — so this is a navigation, not an inline form. */}
          <button
            onClick={() => navigate(CREW_MANAGER_PATH)}
            className="flex items-center justify-center w-7 h-7 rounded-md transition-colors bg-transparent border-none shrink-0 text-muted hover:text-text hover:bg-bg-hover cursor-pointer"
            aria-label={t('pages.membersPage.add_member')}
            title={t('pages.membersPage.add_member')}
            data-testid="member-add"
          >
            <UserPlus size={15} />
          </button>
        </div>
        <div className="px-4 pb-2 text-[11px] text-muted" data-testid="member-count">
          {/* "N of M" while any filter (not the search) narrows the list, so
              the header never contradicts a 1-row or empty view below it. */}
          {starredOnly || sourceFilter !== 'all'
            ? t('pages.membersPage.member_count_filtered', {
                shown: sortedMembers.length,
                count: members.length,
              })
            : t('pages.membersPage.member_count', { count: members.length })}
        </div>
        {/* A failed registry read blanks EVERY roster badge at once. That is
            not "no member has a patrol" — it is a page-level unknown, so it
            is said here, on the roster the badges live on, not only inside
            whichever drawer happens to be open. Same shared notice as the
            drawer block; a read failure on a page holding no draft is safe
            to hand to the agent. */}
        {patrol.failed && (
          <div className="px-4 pb-2">
            <ErrorNotice
              message={t('pages.membersPage.patrol_error_roster')}
              variant="inline"
              askAgent
              testId="member-roster-patrol-error"
            />
          </div>
        )}
        {/* Same search idiom as the Sessions sidebar. */}
        <div className="px-2 pb-1">
          <SearchInput
            className="w-full"
            placeholder={t('pages.membersPage.search_members')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            data-testid="member-search"
          />
        </div>
        {/* Filter chips: star toggle first, then origin. Pressed state is
            aria-pressed so the filter reads to AT as a toggle, not a link. */}
        <div className="px-2 pb-2 flex flex-wrap items-center gap-1" data-testid="member-filters">
          <button
            type="button"
            onClick={toggleStarredOnly}
            aria-pressed={starredOnly}
            className={`inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px] border transition-colors ${
              starredOnly
                ? 'border-accent text-accent bg-accent-subtle'
                : 'border-border text-muted hover:text-text hover:bg-bg-hover'
            }`}
            title={t('pages.membersPage.filter_starred_description')}
            data-testid="member-filter-starred"
          >
            <Star
              size={11}
              className="lucide-inline"
              {...(starredOnly ? { fill: 'var(--accent)', stroke: 'none' } : {})}
            />
            {t('pages.membersPage.filter_starred')}
            {starredCount > 0 && <span className="opacity-70">{starredCount}</span>}
          </button>
          {SOURCE_CHIPS.map((chip) => (
            <button
              key={chip}
              type="button"
              onClick={() => pickSource(chip)}
              aria-pressed={sourceFilter === chip}
              className={`inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px] border transition-colors ${
                sourceFilter === chip
                  ? 'border-accent text-accent bg-accent-subtle'
                  : 'border-border text-muted hover:text-text hover:bg-bg-hover'
              }`}
              title={t(SOURCE_CHIP_TITLE_KEY[chip])}
              data-testid={`member-filter-source-${chip}`}
            >
              {t(SOURCE_CHIP_LABEL_KEY[chip])}
              <span className="opacity-70">{sourceCounts[chip]}</span>
            </button>
          ))}
        </div>
        {/* Star-write failure. Falsy message renders nothing. askAgent is ON:
            the roster holds no unsaved draft, so the hand-off's navigation
            destroys nothing (AUTOSDE errors-use-error-notice). */}
        <div className="px-2">
          <ErrorNotice
            message={starError?.message}
            report={starError?.report}
            title={t('pages.membersPage.star_failed_title')}
            onDismiss={() => setStarError(null)}
            askAgent
            testId="member-star-error"
          />
        </div>
        {gone && gone.shown === '' && (
          /* Below md a stale link lands on the roster; this is where the
             answer to "where did they go" has to live. Same tone as the
             thread-side notice. */
          <div className="px-4 py-1.5 text-[13px] text-warn" role="status" data-testid="member-gone-roster-notice">
            {t('pages.membersPage.member_gone_roster', { name: gone.name })}
          </div>
        )}
        <ul
          className="flex-1 overflow-y-auto scrollbar-none list-none m-0 px-2 pb-2"
          style={{ scrollbarWidth: 'none' }}
          aria-label={t('pages.membersPage.title')}
        >
          {loaded && !loadError && members.length === 0 && (
            <li className="px-4 py-6 text-xs text-muted">
              <p>{t('pages.membersPage.empty_roster')}</p>
              {/* The copy names the crew manager; give it the way there. */}
              <button
                onClick={() => navigate(CREW_MANAGER_PATH)}
                className="mt-2 inline-flex items-center gap-1 text-[11.5px] px-2 py-1 rounded border border-border hover:bg-accent/40"
                data-testid="member-empty-cta"
              >
                <Pencil size={12} className="lucide-inline" />
                {t('pages.membersPage.edit_in_crew_manager')}
              </button>
            </li>
          )}
          {loadError && (
            <li className="px-4 py-6 text-xs text-muted" role="alert">
              {t('pages.membersPage.roster_load_failed')}
            </li>
          )}
          {filteredOut && (
            <li className="px-4 py-6 text-xs text-muted" data-testid="member-filtered-out">
              <p>{t('pages.membersPage.filters_hide_all')}</p>
              <button
                type="button"
                onClick={() => {
                  if (starredOnly) toggleStarredOnly()
                  if (sourceFilter !== 'all') pickSource(sourceFilter)
                }}
                className="mt-2 inline-flex items-center gap-1 text-[11.5px] px-2 py-1 rounded border border-border hover:bg-accent/40"
                data-testid="member-filters-clear"
              >
                {t('pages.membersPage.filters_clear')}
              </button>
            </li>
          )}
          {sortedMembers.map((m) => (
            <li key={m.name} className="group/row relative">
              {/* Same rounded-row idiom as ChatSidebar's session rows, so the
                  two conversation lists read as one family. The star is a
                  SIBLING of the row button, not a child: a button inside a
                  button is invalid HTML and breaks keyboard activation. It is
                  absolutely placed over the row's right padding so the row
                  keeps its single click target and the label its width. */}
              <button
                onClick={() => openMember(m)}
                className={`w-full flex items-center gap-2.5 pl-2.5 pr-8 py-2 rounded-md text-left transition-all select-none ${
                  m.name === activeName
                    ? 'text-text-strong bg-accent-subtle'
                    : 'text-muted hover:text-text hover:bg-bg-hover'
                }`}
                aria-current={m.name === activeName ? 'true' : undefined}
              >
                <span className="relative shrink-0">
                  {/* The face reacts: it animates while the member works and
                      flashes its finished / failed expression on the turn's
                      trailing edge. The dot below stays presence-only — a
                      finished turn is not presence. */}
                  <CrewStateAvatar
                    seed={m.name}
                    avatar={m.avatar}
                    slotKey={slots[m.name] || m.slot_key}
                    running={!!isRunning(m)}
                    size={36}
                    working="subtle"
                  />
                  {/* Presence dot renders only while the member is working —
                      an idle member shows nothing rather than a gray dot,
                      which read as a broken/disabled state. */}
                  {isRunning(m) && (
                    <span
                      className="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full border-2 border-bg bg-ok"
                      aria-hidden="true"
                      data-testid="member-presence-dot"
                    />
                  )}
                  {/* Patrol badge — the member has an auto-nudge loop on its
                      own thread. Accent while it patrols; warn once the loop
                      has STOPPED, because a dead patrol is the thing this
                      page exists to make visible at a glance, not only after
                      the drawer opens. Top-right corner of the avatar, the
                      composer's goal-chip glyph on a solid fill (the presence
                      dot's own idiom — an outline read as nothing at a
                      glance): a different corner from the presence dot (bottom-right, ok-green, "working now") and
                      a different edge from the row's right-side markers, so
                      all of them can show at once without covering each
                      other. Mount/unmount and the colour flip are animated:
                      a badge that pops in or changes mid-glance is what a
                      state change looks like when it is not a glitch. */}
                  <AnimatePresence initial={false}>
                    {(() => {
                      const badge = patrolBadgeOf(m)
                      if (!badge) return null
                      const lp = patrolLoopOf(m)
                      // The tooltip spells the count the drawer's way ("3 of 24"
                      // / "61 · no limit"): the compact "3/24" alone read as a date.
                      const cycle = lp
                        ? lp.max_cycles > 0
                          ? t('pages.membersPage.patrol_cycles_of', { n: lp.cycle_count, max: lp.max_cycles })
                          : t('pages.membersPage.patrol_cycles_unlimited', { n: lp.cycle_count })
                        : ''
                      const label =
                        badge === 'active'
                          ? t('pages.membersPage.patrol_badge', { cycle })
                          : t('pages.membersPage.patrol_badge_stopped')
                      return (
                        <motion.span
                          key="patrol"
                          initial={{ opacity: 0, scale: 0.6 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.6 }}
                          transition={{ duration: 0.15, ease: [0.2, 0, 0, 1] }}
                          className={`absolute -right-1 -top-1 w-4 h-4 rounded-full border-2 border-bg flex items-center justify-center transition-colors duration-150 ${
                            badge === 'active' ? 'bg-accent text-accent-fg' : 'bg-warn text-warn-fg'
                          }`}
                          role="img"
                          aria-label={label}
                          title={label}
                          data-testid="member-patrol-dot"
                          data-state={badge}
                        >
                          {/* Distinct glyph per state, not colour alone: the
                              goal target while patrolling, a pause mark once
                              stopped, so the two read apart without the hover. */}
                          {badge === 'active' ? (
                            <Goal size={10} aria-hidden="true" />
                          ) : (
                            <Pause size={9} aria-hidden="true" strokeWidth={3} />
                          )}
                        </motion.span>
                      )
                    })()}
                  </AnimatePresence>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium truncate">{m.name}</span>
                  {/* Last-message preview, like a session row — presence
                      already rides the avatar dot, so a textual Idle/Working
                      label said nothing the dot did not. */}
                  <span className="block text-[11px] text-muted truncate">
                    {m.last_message || '\u00a0'}
                  </span>
                </span>
                {/* Unread marker on the row's right edge — the IM convention
                    (and where the rail badge sits), vertically centered by the
                    row's items-center. Accent-filled w-2 h-2 like ChatSidebar's
                    unread dot, with a real accessible name: nothing else on
                    the row says "unread". The left side is taken — presence
                    rides the avatar. */}
                {isUnread(m) && (
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: 'var(--accent)' }}
                    role="img"
                    aria-label={t('pages.membersPage.unread_message')}
                    title={t('pages.membersPage.unread_message')}
                    data-testid="member-unread-dot"
                  />
                )}
              </button>
              {/* Star: always rendered when starred. Unstarred: visible below md
                  (touch has no hover or keyboard focus to reveal it), hover /
                  focus-revealed at md+ so a desktop roster stays quiet. Never
                  hidden from AT — opacity, not display. */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  toggleStar(m)
                }}
                aria-pressed={!!m.starred}
                disabled={starPending.has(m.name)}
                aria-label={t(m.starred ? 'pages.membersPage.unstar' : 'pages.membersPage.star', { name: m.name })}
                title={t(m.starred ? 'pages.membersPage.unstar' : 'pages.membersPage.star', { name: m.name })}
                // 24x24 minimum target (the icon is 13px): a touch that lands beside
                // the glyph must hit the star, not the row button underneath.
                className={`absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center w-6 h-6 rounded hover:bg-bg-hover transition-opacity ${
                  m.starred
                    ? 'opacity-100 text-accent'
                    : 'md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100 text-muted'
                }`}
                data-testid={`member-star-${m.slug}`}
              >
                <Star
                  size={13}
                  {...(m.starred ? { fill: 'var(--accent)', stroke: 'none' } : {})}
                />
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* Shared window-splitter between roster and thread: keyboard-operable,
          md+ only (below md the page is single-pane, nothing to resize). */}
      <div className="hidden md:flex" data-testid="member-roster-resize">
        <ResizeHandle
          handleProps={roster.handleProps}
          label={t('pages.membersPage.title')}
          onNudge={roster.nudge}
          value={roster.width}
          min={ROSTER_MIN}
          max={ROSTER_MAX}
        />
      </div>

      {/* DM thread */}
      <section
        className={`${activeName ? 'flex' : 'hidden md:flex'} flex-1 min-w-0 flex-col min-h-0`}
      >
        {!active && (
          <div className="flex-1 flex items-center justify-center text-sm text-muted px-6 text-center">
            {t('pages.membersPage.pick_a_member')}
          </div>
        )}
        {active && (
          <>
            <header className="flex items-center gap-2.5 px-4 py-2 border-b border-border">
              <button
                // Back to the roster. When this entry was pushed from the
                // roster on this page, pop it — the browser's own Back then
                // lands on whatever preceded the roster, with no duplicate
                // roster entry. A deep link (no such state) has no roster
                // entry behind it, so drop the param in place instead.
                onClick={() => {
                  if ((location.state as { fromRoster?: boolean } | null)?.fromRoster) navigate(-1)
                  else setSearchParams({}, { replace: true })
                }}
                className="md:hidden inline-flex items-center p-1 -ml-1 rounded hover:bg-accent/40"
                aria-label={t('pages.membersPage.title')}
                data-testid="member-back"
              >
                <ArrowLeft size={16} className="lucide-inline" />
              </button>
              {/* The face is the one place a new user tries first, so it is
                  the entry to the avatar builder — visibly (hover scrim +
                  pencil, persistent badge on touch) and with a one-time
                  "Edit this avatar" chip while the member still wears its
                  name-derived default. The chip lives HERE because this is the
                  page's resting view: the drawer's "Edit avatar" text route is
                  behind the Details toggle (closed by default below md), so the
                  header face is the only entry on screen when the page opens.
                  It navigates to the crew manager rather than editing here:
                  this page never becomes a second writer (issue #9103). The
                  face inside is the same reactive CrewStateAvatar as before —
                  wrapping it changes nothing about how it draws or reacts. */}
              <CrewAvatarButton
                size={30}
                onEdit={() => navigate(crewAvatarEditPath(active.name))}
                hint={!hasAvatarOverride(active.avatar)}
                data-testid="member-avatar-button"
              >
                <CrewStateAvatar
                  seed={active.name}
                  avatar={active.avatar}
                  slotKey={activeSlot || active.slot_key}
                  running={!!isRunning(active)}
                  size={30}
                  working="full"
                />
              </CrewAvatarButton>
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-semibold truncate">{active.name}</div>
              </div>
              {/* The header carries NO panel control while the panel sits
                  beside the thread: that panel is permanent, so a toggle would
                  promise a close the strip does not offer. Only when the window
                  is too narrow for a column (see panelSitsBeside) does the
                  panel become an overlay, and then this is its opener — same
                  icon and hit-target as the chat page's side-panel toggle, so
                  the two surfaces teach one gesture. The pin chip was removed:
                  every member thread is pinned by construction (a server
                  invariant, not a per-thread state), so announcing it taught
                  the user a term for a thing that can never be otherwise.
                  Edit lives inside the Crew summary tab: it is a rare,
                  secondary action, not a header-level peer. */}
              {!beside && (
                <button
                  onClick={() => setOverlayOpen((v) => !v)}
                  className="flex items-center justify-center w-7 h-7 rounded-md transition-colors bg-transparent border-none shrink-0 text-muted hover:text-text hover:bg-bg-hover cursor-pointer"
                  aria-pressed={overlayOpen}
                  aria-controls="member-side-panel"
                  aria-label={t('pages.membersPage.details')}
                  title={t('pages.membersPage.details')}
                  data-testid="member-panel-toggle"
                >
                  <PanelRightSolid size={15} />
                </button>
              )}
            </header>
            {/* A failed document read from the panel's Files / Artifacts tabs.
                Reported here, above the thread, rather than inside the tab
                that failed to open — there is no such tab. Dismissable; the
                agent hand-off is on because nothing here holds a draft. */}
            {actionError && (
              <ErrorNotice
                message={actionError}
                onDismiss={() => setActionError('')}
                askAgent
                testId="member-panel-action-error"
              />
            )}
            {gone && gone.shown === active.name && (
              /* Decision-critical (the user is about to type into a thread they
                 did not ask for), so it wears the warn tone at body size, not
                 the drawer's muted timestamp style. A status, not an alert:
                 the fallback did open something. */
              <div className="px-4 py-2 text-[13px] text-warn" role="status" data-testid="member-gone-notice">
                {t('pages.membersPage.member_gone', { name: gone.name, shown: gone.shown })}
              </div>
            )}
            {activeError && (
              <div className="px-4 py-2 text-xs text-danger" role="alert">
                {activeError}
              </div>
            )}
            {activeSlot ? (
              <div className="flex-1 min-h-0">
                <ErrorBoundary>
                  {/* Same reading measure as the main chat transcript — the
                      pane resolves the user's Content width setting itself
                      (transcript and composer both). The DM column is the
                      page's widest region, and an uncapped line length is
                      unreadable on wide screens. */}
                  <ChatPane slotKey={activeSlot} agentLocked frameless followContentWidth />
                </ErrorBoundary>
              </div>
            ) : (
              !activeError && (
                <div className="flex-1 flex items-center justify-center text-xs text-muted">
                  {t('pages.membersPage.opening_thread')}
                </div>
              )
            )}
          </>
        )}
      </section>
      </div>

      {/* Side panel — the chat page's tabbed SidePanel, docked to this page.
          Read-only observation lives in its permanent first tab (Crew
          summary); writes live in the crew manager. The + menu is the chat
          panel's own (Files / Artifacts / Terminal / Browser / Side chat …),
          all against the member's DM slot, and the strip is bucketed per
          member so it follows the roster selection. Wide windows dock it as a
          column with NO close control (it is part of the page, like the roster);
          narrow ones make it an overlay the header button opens, with the
          panel's own close control, on the chat page's dock motion. */}
      {active && (() => {
          const summaryBody = (
            <div className="px-3 py-3" data-testid="member-crew-summary" aria-label={t('pages.membersPage.crew_summary')}>
          {/* Identity + live status line — working now, or the last time
              anything happened on the thread. The chip above names the tab
              (Crew summary) and wears the face; this row names the member. */}
          <div className="flex items-center gap-2 mb-3 min-w-0">
            <CrewAvatar seed={active.name} avatar={active.avatar} size={22} />
            <span className="text-[13px] font-semibold truncate">{active.name}</span>
            <span className="text-[11px] truncate ml-auto shrink-0" data-testid="member-summary-status">
              {isRunning(active) ? (
                <span className="text-ok">{t('pages.membersPage.drawer_working')}</span>
              ) : active.last_active_ts ? (
                <span className="text-muted">{timeAgo(active.last_active_ts)}</span>
              ) : null}
            </span>
          </div>
          {/* Honest counters only — both derive from the recorded activity
              log. Semantic stats the backend cannot attest (PRs, triages,
              spend) are deliberately absent rather than fabricated. */}
          <div className="grid grid-cols-2 gap-2 mb-4" data-testid="member-stats">
            <div className="border border-border rounded-lg px-3 py-2">
              <div className="text-lg font-semibold leading-tight">
                {activityLoading || activityError ? '\u2013' : `${todayCount}${todayIsFloor ? '+' : ''}`}
              </div>
              <div className="text-[11px] text-muted">{t('pages.membersPage.stat_today')}</div>
            </div>
            <div className="border border-border rounded-lg px-3 py-2">
              <div className="text-lg font-semibold leading-tight">
                {activityLoading || activityError ? '\u2013' : `${weekCount}${weekIsFloor ? '+' : ''}`}
              </div>
              <div className="text-[11px] text-muted">{t('pages.membersPage.stat_week')}</div>
            </div>
          </div>
          {/* Sessions this member is driving — the worker sessions it opened
              and steers. Live rows off the WS slots frames (see the
              drivingSessions memo); each row is a jump into that session.
              The status dot is the sidebar's vocabulary: approval (warn) >
              needs input (info) > running (ok) > idle (muted). */}
          <div className="text-[11px] font-semibold tracking-wide text-muted mb-1.5">
            {t('pages.membersPage.driving_sessions')}
          </div>
          {drivingSessions.length === 0 && !slotsLoaded ? (
            <div className="mb-4 space-y-1.5" data-testid="member-driving-loading" aria-hidden>
              <div className="h-3 rounded bg-accent/40 animate-pulse" />
              <div className="h-3 w-3/4 rounded bg-accent/40 animate-pulse" />
            </div>
          ) : drivingSessions.length === 0 ? (
            <div className="text-[11px] text-muted mb-4" data-testid="member-driving-empty">
              {t('pages.membersPage.driving_none')}
            </div>
          ) : (
            <div className="mb-4">
              <ul className="list-none m-0 p-0 space-y-0.5" data-testid="member-driving-sessions">
                {visibleDriving.map((s) => {
                  // Precedence is the shared tab-status contract (approval and
                  // question outrank running); no unread set here, so the
                  // fourth state is plain idle.
                  const kind = tabStatus(s, [], s.key)
                  const status = DRIVING_STATUS[kind]
                  const label = t(status.label)
                  // Slot timestamps are ISO strings; timeAgo wants epoch seconds.
                  const activityTs = lastActivityEpoch(s)
                  const title = s.title || s.key
                  return (
                    <li key={s.key}>
                      <button
                        type="button"
                        onClick={() => navigate(`/chat?sid=${encodeURIComponent(s.key)}`)}
                        className="w-full text-left flex items-center gap-2 text-[11px] px-1.5 py-1 -mx-1.5 rounded hover:bg-accent/40"
                        title={title + PROJECT_SEPARATOR + label}
                        data-testid="member-driving-row"
                        data-status={kind}
                      >
                        <Circle size={8} className={`shrink-0 ${status.cls}`} aria-hidden />
                        <span className="min-w-0 truncate flex-1">{title}</span>
                        {/* The two states parked on the user get words, not
                            just a colour — the sidebar's own idiom for the
                            same signals; running/idle stay dot-only (the
                            label is in the hover title and for AT). */}
                        {status.spoken ? (
                          <span className={`shrink-0 font-medium ${status.text}`}>{label}</span>
                        ) : (
                          <span className="sr-only">{label}</span>
                        )}
                        {activityTs > 0 && (
                          <span className="text-muted shrink-0 whitespace-nowrap">{timeAgo(activityTs)}</span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
              {drivingSessions.length > DRIVING_VISIBLE && (
                <button
                  type="button"
                  onClick={() => setDrivingExpandedFor(drivingExpanded ? '' : activeMemberKey)}
                  className="mt-1 text-[11px] text-muted hover:text-text"
                  aria-expanded={drivingExpanded}
                  data-testid="member-driving-toggle"
                >
                  {drivingExpanded
                    ? t('pages.membersPage.driving_show_less')
                    : t('pages.membersPage.driving_show_all', { count: drivingSessions.length })}
                </button>
              )}
            </div>
          )}
          {/* Auto patrol — the auto-nudge loop on this member's own thread,
              beside the sessions it drives: together they answer "is this
              member alive, and what is it doing". Three verdicts, never
              conflated (see patrolState), plus the loading / failed states
              every block in this drawer keeps. The readouts are the composer's
              goal chip's: same cycle spelling, same deadline-preserving
              countdown, same "last fire" wording — so a person who has read
              one has read the other. The block cross-fades on a verdict
              change; a stop that lands while the drawer is open must read as
              a change, not a flicker. */}
          <div className="text-[11px] font-semibold tracking-wide text-muted mb-1.5 flex items-center gap-1.5">
            <Goal
              size={12}
              className={`lucide-inline shrink-0 ${patrolState === 'active' ? 'text-accent' : 'text-muted'}`}
              aria-hidden="true"
            />
            <span className="flex-1">{t('pages.membersPage.patrol_title')}</span>
          </div>
          {!patrol.loaded ? (
            <div className="mb-4 space-y-1.5" data-testid="member-patrol-loading" aria-hidden>
              <div className="h-3 rounded bg-bg-hover animate-pulse" />
              <div className="h-3 w-3/4 rounded bg-bg-hover animate-pulse" />
            </div>
          ) : patrol.failed ? (
            /* The shared notice, not a hand-rolled alert: it keeps the
               structured error context and the agent hand-off. askAgent is
               safe here — a read failure on a drawer that holds no draft. */
            <div className="mb-4">
              <ErrorNotice
                message={t('pages.membersPage.patrol_error')}
                variant="inline"
                askAgent
                testId="member-patrol-error"
              />
            </div>
          ) : (
            <motion.div
              key={patrolState}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
              className="mb-4"
              data-testid="member-patrol"
              data-state={patrolState}
            >
              {patrolState === 'active' && activePatrol ? (
                <>
                  <div className="text-[11px] font-medium text-accent mb-1.5" data-testid="member-patrol-status">
                    {t('pages.membersPage.patrol_active')}
                  </div>
                  {/* Same label/value idiom as the Configuration list below. */}
                  <dl className="text-[11px] space-y-1 m-0">
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0 text-muted">{t('pages.membersPage.patrol_interval')}</dt>
                      <dd className="min-w-0 truncate m-0" data-testid="member-patrol-interval">
                        {intervalText(activePatrol.idle_secs)}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0 text-muted">{t('pages.membersPage.patrol_cycles')}</dt>
                      <dd className="min-w-0 truncate m-0" data-testid="member-patrol-cycles">
                        {/* Self-describing here ("3 of 24"); the chip keeps its
                            compact "3/24", which alone read as a date. */}
                        {activePatrol.max_cycles > 0
                          ? t('pages.membersPage.patrol_cycles_of', { n: activePatrol.cycle_count, max: activePatrol.max_cycles })
                          : t('pages.membersPage.patrol_cycles_unlimited', { n: activePatrol.cycle_count })}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0 text-muted">{t('pages.membersPage.patrol_last_wake')}</dt>
                      <dd
                        className="min-w-0 truncate m-0"
                        title={activePatrol.last_fire_ts ? fmtDateTimeNumeric(activePatrol.last_fire_ts) : undefined}
                      >
                        {activePatrol.last_fire_ts
                          ? timeAgo(activePatrol.last_fire_ts)
                          : t('components.autoNudgePopover.never')}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0 text-muted">{t('pages.membersPage.patrol_next_wake')}</dt>
                      <dd
                        className="min-w-0 truncate m-0"
                        title={activePatrol.next_due_ts > 0 ? fmtDateTimeNumeric(activePatrol.next_due_ts) : undefined}
                        data-testid="member-patrol-next"
                      >
                        {(() => {
                          // The row already says "Next wake", so the value is
                          // the bare remainder; the due / unscheduled readings
                          // are the composer chip's own sentences.
                          const next = nextCycle(activePatrol, nowTs)
                          switch (next.kind) {
                            case 'in':
                              return t('pages.membersPage.patrol_next_in', { time: next.time })
                            case 'due':
                              return t('components.autoNudgePopover.next_cycle_due')
                            default:
                              return t('components.autoNudgePopover.next_cycle_unscheduled')
                          }
                        })()}
                      </dd>
                    </div>
                    {(activePatrol.banner || activePatrol.message) && (
                      <div className="flex gap-2">
                        <dt className="w-24 shrink-0 text-muted">{t('pages.membersPage.patrol_instruction')}</dt>
                        {/* The banner is the SHORT stand-in the transcript row
                            shows; without one, the instruction's first line.
                            The full text sits in the hover title. */}
                        <dd
                          className="min-w-0 truncate m-0"
                          title={activePatrol.banner || activePatrol.message}
                          data-testid="member-patrol-instruction"
                        >
                          {(activePatrol.banner || activePatrol.message).split('\n')[0]}
                        </dd>
                      </div>
                    )}
                  </dl>
                </>
              ) : patrolState === 'stopped' && activePatrol ? (
                <div className="text-[11px] text-muted" data-testid="member-patrol-status">
                  <span className="text-text">{t('pages.membersPage.patrol_stopped')}</span>
                  {activePatrol.stopped_reason && (
                    <span className="block mt-0.5" data-testid="member-patrol-reason">
                      {PATROL_STOPPED_REASON[activePatrol.stopped_reason]
                        ? t(PATROL_STOPPED_REASON[activePatrol.stopped_reason])
                        : activePatrol.stopped_reason}
                    </span>
                  )}
                  {activePatrol.last_fire_ts > 0 && (
                    <span className="block mt-0.5" title={fmtDateTimeNumeric(activePatrol.last_fire_ts)}>
                      {t('pages.membersPage.patrol_last_wake_ago', { when: timeAgo(activePatrol.last_fire_ts) })}
                    </span>
                  )}
                </div>
              ) : (
                <div className="text-[11px] text-muted" data-testid="member-patrol-status">
                  {t('pages.membersPage.patrol_none')}
                </div>
              )}
            </motion.div>
          )}
          <div className="text-[11px] font-semibold tracking-wide text-muted mb-1.5">
            {t('pages.membersPage.recent_activity')}
          </div>
          {/* Three states, never conflated: a pending or failed read must not
              render the affirmative "no recorded activity". */}
          {activityLoading ? (
            <div className="mb-4 space-y-1.5" data-testid="member-activity-loading" aria-hidden>
              <div className="h-3 rounded bg-accent/40 animate-pulse" />
              <div className="h-3 w-3/4 rounded bg-accent/40 animate-pulse" />
            </div>
          ) : activityError ? (
            <div className="text-[11px] text-muted mb-4" role="alert" data-testid="member-activity-error">
              {t('pages.membersPage.activity_error')}
            </div>
          ) : activeEntries.length === 0 ? (
            <div className="text-[11px] text-muted mb-4">
              {t('pages.membersPage.activity_empty')}
            </div>
          ) : (
            <ul className="list-none m-0 p-0 mb-4 space-y-1.5" data-testid="member-activity">
              {activeEntries.slice(0, 8).map((e, i) => (
                <li
                  key={`${e.ts}-${i}`}
                  className="flex gap-2 text-[11px] border-b border-border/60 pb-1.5 last:border-b-0"
                >
                  <span className="text-muted shrink-0 whitespace-nowrap">{timeAgo(e.ts)}</span>
                  <span className="min-w-0 truncate">
                    {e.via === 'select_crew'
                      ? t('pages.membersPage.activity_routed')
                      : t('pages.membersPage.activity_chat')}
                    {e.project ? PROJECT_SEPARATOR + e.project : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="text-[11px] font-semibold tracking-wide text-muted mb-1.5 flex items-center">
            <span className="flex-1">{t('pages.membersPage.wake_sources')}</span>
            {/* Read-only view; managing schedules stays on the Schedule page
                (same jump idiom as the crew editor's wake pane). */}
            <button
              onClick={() => navigate('/schedule')}
              className="inline-flex items-center p-0.5 rounded hover:bg-accent/40 text-muted hover:text-text"
              aria-label={t('pages.membersPage.open_schedule')}
              title={t('pages.membersPage.open_schedule')}
              data-testid="member-wake-jump"
            >
              <ExternalLink size={12} className="lucide-inline" />
            </button>
          </div>
          {!wake.loaded && !wake.failed ? (
            <div className="mb-4 space-y-1.5" data-testid="member-wake-loading" aria-hidden>
              <div className="h-3 rounded bg-accent/40 animate-pulse" />
            </div>
          ) : wake.failed ? (
            <div className="text-[11px] text-muted mb-4" role="alert" data-testid="member-wake-error">
              {t('pages.membersPage.wake_error')}
            </div>
          ) : wakeJobs.length === 0 && wakeHooks.length === 0 && patrolState !== 'active' ? (
            <div className="text-[11px] text-muted mb-4">{t('pages.membersPage.wake_none')}</div>
          ) : (
            <ul className="list-none m-0 p-0 mb-4 space-y-1.5" data-testid="member-wake-sources">
              {/* An active patrol IS a wake source — the one this member set
                  for itself. Listing it here keeps the card from saying
                  "Last wake 6m ago" above "Nothing wakes this member". */}
              {patrolState === 'active' && activePatrol && (
                <li className="flex items-center gap-2 text-[11px]" data-testid="member-wake-patrol">
                  <Goal size={12} className="lucide-inline text-accent shrink-0" aria-hidden="true" />
                  <span className="min-w-0 truncate flex-1">{t('pages.membersPage.patrol_title')}</span>
                  <span className="text-muted shrink-0">
                    {t('pages.membersPage.wake_patrol_every', { every: intervalText(activePatrol.idle_secs) })}
                  </span>
                </li>
              )}
              {wakeJobs.map((jb) => (
                <li key={jb.id} className="flex items-center gap-2 text-[11px]">
                  <Clock size={12} className="lucide-inline text-muted shrink-0" />
                  <span className={`min-w-0 truncate flex-1 ${jb.enabled ? '' : 'text-muted'}`}>
                    {jb.name}
                    {!jb.enabled && ` (${t('pages.membersPage.wake_paused')})`}
                  </span>
                  <span className="font-mono text-muted shrink-0 max-w-[45%] truncate" title={jb.schedule}>
                    {jb.schedule}
                  </span>
                </li>
              ))}
              {wakeHooks.map((tk) => (
                <li key={tk.id} className="flex items-center gap-2 text-[11px]">
                  <Webhook size={12} className="lucide-inline text-muted shrink-0" />
                  <span className={`min-w-0 truncate flex-1 ${tk.enabled === false ? 'text-muted' : ''}`}>
                    {tk.label}
                    {tk.enabled === false && ` (${t('pages.membersPage.wake_paused')})`}
                  </span>
                  <span className="text-muted shrink-0">{t('pages.membersPage.wake_webhook')}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="text-[11px] font-semibold tracking-wide text-muted mb-2">
            {t('pages.membersPage.configuration')}
          </div>
          <dl className="text-xs space-y-2">
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted">
                {t('pages.membersPage.agent_template')}
              </dt>
              <dd className="min-w-0 truncate">{active.kiro_agent || t('pages.membersPage.inherited')}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted">{t('pages.membersPage.model')}</dt>
              <dd className="min-w-0 truncate">{active.model || t('pages.membersPage.inherited')}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted">
                {t('pages.membersPage.workspace')}
              </dt>
              <dd className="min-w-0 truncate">{String(active.workspace ?? '')}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted">
                {t('pages.membersPage.memory_store')}
              </dt>
              <dd className="min-w-0 truncate">{String(active.memory_store ?? '')}</dd>
            </div>
          </dl>
          {/* Honest disclosure, always rendered, worded for this member's store.
              Only the markdown layer (preferences, project notes) is read from a
              named memory_store; conversation memory and lessons live in the
              one global vector store every member reads, so "what you tell it
              is known to all of them" stays true on a dedicated store too.
              Store identity is a config fact — never inferred from the roster. */}
          <div className="mt-3 text-[11px] text-muted border border-border rounded-md px-2.5 py-2">
            {String(active.memory_store || 'default') === 'default'
              ? t('pages.membersPage.memory_shared_note')
              : t('pages.membersPage.memory_dedicated_note', {
                  store: String(active.memory_store),
                })}
          </div>
          {/* Two exits, both into the crew manager (the only writer). "Edit
              avatar" lands directly in the builder for THIS member — the
              text route for a user who never guessed the face was clickable;
              "Edit in crew manager" keeps landing on the roster. */}
          <button
            onClick={() => navigate(crewAvatarEditPath(active.name))}
            className="mt-4 w-full inline-flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-md border border-border hover:bg-accent/40"
            title={t('components.avatarBuilder.edit_avatar')}
            data-testid="member-edit-avatar"
          >
            <UserPen size={12} className="lucide-inline" />
            {t('components.avatarBuilder.edit_avatar')}
          </button>
          <button
            onClick={() => navigate(CREW_MANAGER_PATH)}
            className="mt-2 w-full inline-flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-md border border-border hover:bg-accent/40"
          >
            <Pencil size={12} className="lucide-inline" />
            {t('pages.membersPage.edit_in_crew_manager')}
          </button>
            </div>
          )
          const leadingTab: SidePanelLeadingTab = {
            id: CREW_SUMMARY_TAB_ID,
            title: t('pages.membersPage.crew_summary'),
            // The member's face, not a kind glyph: the chip is the one place
            // the strip says WHOSE panel this is, and it changes with the
            // roster selection — unlike the chat page's ListTree Summary tab,
            // which summarises a transcript.
            icon: <CrewAvatar seed={active.name} avatar={active.avatar} size={16} />,
            render: () => summaryBody,
          }
          // Everything both placements share. `slot` is the member's live DM
          // slot as CONFIRMED by the thread endpoint — empty until then, when
          // every slot-bound view is withheld (`hiddenViews`) — so the + menu's
          // views — Side chat, Artifacts, Terminal — address exactly the session
          // ChatPane is showing and never a stale binding's occupant. No bottom
          // dock: this page has no bottom grid row for it to move into.
          const panelProps = {
            tabsCtl,
            slot: confirmedSlot,
            hiddenViews,
            onActiveTabChange: setShownTabId,
            projectDir,
            onFileOpen: openFile,
            onArtifactOpen: openArtifact,
            onFileSave: saveFile,
            leadingTab,
            slotTitle: active.name,
            canDockBottom: false,
          }
          // ONE SidePanel instance for both placements. Docked and overlay differ
          // only in the wrapper (an in-flow column vs a fixed sheet below the
          // 42px app topbar) and in the motion axis (the chat page's width
          // reveal vs a slide from the right edge), so they share one keyed
          // element and the panel is never remounted by a placement flip — a
          // live Browser tab's WebContentsView, like an app tab's frame, does
          // not survive a remount. For the same reason a CLOSED overlay stays
          // MOUNTED and hidden while such a tab exists (`shouldMountSidePanel`
          // / `isSidePanelHidden`, the chat page's exact rule); with no live
          // tab it unmounts on close, which preserves the exit motion. Both
          // axes are named in every target — see sidePanelDockMotion for why an
          // axis left out of `animate` freezes at its last value.
          // Two nested motion elements in BOTH placements so the SidePanel
          // instance is the same React subtree whichever way it is shown. Docked:
          // the outer is the chat page's width reveal and the inner is inert.
          // Overlay: the outer is a full-bleed SCRIM below the 42px app topbar
          // (fades in; a click on it closes the overlay — the whole chat column
          // is dimmed rather than left peeking out as a sliver beside the panel,
          // which read as a rendering fault) and the inner slides the panel in
          // from the right edge. Both axes are named in every target — see
          // sidePanelDockMotion for why an axis left out of `animate` freezes.
          const outerMotion = beside
            ? dockMotion
            : {
              initial: { opacity: 0, width: 'auto', height: '100%' },
              animate: { opacity: 1, width: 'auto', height: '100%' },
              exit: { opacity: 0, width: 'auto', height: '100%' },
            }
          const innerMotion = beside
            ? { initial: { x: 0 }, animate: { x: 0 }, exit: { x: 0 } }
            : { initial: { x: '100%' }, animate: { x: 0 }, exit: { x: '100%' } }
          return (
            <AnimatePresence initial={false}>
              {panelMounted && (
                <motion.div
                  key="member-side-panel"
                  id="member-side-panel"
                  initial={outerMotion.initial}
                  animate={outerMotion.animate}
                  exit={outerMotion.exit}
                  transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
                  className={beside
                    ? 'h-full overflow-visible flex justify-end shrink-0'
                    /* The overlay MUST be dismissable, so it is the one placement
                       that hands the panel an onClose — and the scrim is a second
                       dismiss, the drawer convention. On a phone the panel's
                       mobile `100%` width fills the scrim; on a tablet-width
                       window the panel keeps its own (resizable, persisted)
                       width against the dimmed chat. */
                    : 'fixed top-safe-offset-[42px] bottom-safe left-safe right-safe z-40 flex justify-end bg-bg/60 backdrop-blur-sm'}
                  style={panelHidden ? { display: 'none' } : undefined}
                  onClick={beside ? undefined : (e) => { if (e.target === e.currentTarget) closeOverlay() }}
                  data-testid="member-side-panel"
                  data-placement={beside ? 'docked' : 'overlay'}
                >
                  <motion.div
                    initial={innerMotion.initial}
                    animate={innerMotion.animate}
                    exit={innerMotion.exit}
                    transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
                    className={beside ? 'h-full flex justify-end' : 'h-full flex justify-end max-w-full'}
                  >
                    <SidePanel
                      {...panelProps}
                      panelHidden={panelHidden}
                      /* Docked: permanent — no onClose, so the strip renders no
                         close control and Escape inside a view does nothing.
                         `extraReserveW` keeps the live roster width plus the
                         page's gaps clear on top of the shell reserve, so a drag
                         can never fold the thread to nothing (the contract the
                         old drawer's reserveWidth carried). Overlay: the panel
                         covers the thread, so nothing to reserve. */
                      onClose={beside ? undefined : closeOverlay}
                      extraReserveW={beside ? roster.width + PANEL_GAPS_W : 0}
                    />
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          )
        })()}
    </div>
  )
}
