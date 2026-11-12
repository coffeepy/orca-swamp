import { HISTORY_LENGTH, inFlight, isLive, RECENT_LENGTH, repoKey, retryFrom, runActions, sshHostOf, tidyLogin, withVitals, type InputField, type LogText, type RecentRun, type Repo, type Run, type RunAction, type RunId, type RunStatus, type SshHost, type Step, type WorkflowSummary } from './domain'
import type { Inbox, InboxItem } from './inbox'
import {
  ACTION_LOOK,
  actionCommand,
  actionLabel,
  ago,
  approveCommand,
  home,
  inboxGroups,
  inboxId,
  inboxPlace,
  parent,
  workspaceKey,
  parsePlace,
  parsePlaces,
  parseResolutions,
  placeIn,
  resolutionIn,
  withPlace,
  withResolution,
  ALL_RUNS,
  parseRunsView,
  RUN_CHIPS,
  RUN_SORTS,
  runGroups,
  runsShown,
  runsViewIn,
  WHEN_LABEL,
  workflowsShown,
  type RunsView,
  type Places,
  type Resolutions,
  type Place,
  approveLabel,
  INSTALL_COMMAND,
  payloadBlocks,
  remoteOff,
  repoTitle,
  storedNote,
  type PayloadBlock,
  cellsOf,
  isFinished,
  TICKET_LABEL,
  ticketWhen,
  reasonWord,
  whyHere,
  dispatchRun,
  type Cell,
  startCommand,
  duration,
  firstFailed,
  groupWorkflows,
  shortName,
  logLine,
  retryCommand,
  runLook,
  runPill,
  shortId,
  since,
  stepsOf,
  stepTime,
  stepTone,
  PACE_LOOK,
  paceLabel,
  paceProgress,
  paceRow,
  brief,
  pickerNotice,
  PROBLEM_TITLE,
  FAULT_SAYS,
  sayPlain,
  keySteps,
  type PickerNotice,
  type Tone
} from './present'
import { LOG, logText, type LogChunk, type LogLine } from './log'
import { paceOf, usualTimes } from './pace'
import type { AgentTerminal, Connected, ListData } from './protocol'
import type { CodeServer, Resolution } from './repo'
import type { Board, Factories, FactorySummary, Product, Stage, TicketStatus, WorkItem, WorkItemDetail } from './stagecraft'
import { ORCA_STATUS, PALETTES, paletteCss, parseThemeId, THEME_IDS, type ThemeId } from './theme'

type Loadable<T> = { data?: T; error?: { code: string; message: string } }
type Tab = 'logs' | 'outputs' | 'data'
type TicketFilter = 'all' | TicketStatus
type ItemTab = 'now' | 'timeline'
type Decided = WorkItemDetail & { advanced?: string; advanceError?: string }

const LIVE_MS = 2_000
const IDLE_MS = 10_000
// ponytail: the Factories badge refreshes once a minute while Workflows shows, to keep swamp calls down.
const BADGE_MS = 60_000
const INBOX_MS = 30_000
// ponytail: the runs list grows by a button, with no virtual scrolling; the worker sends 500 runs at most.
const RUNS_FIRST = 20
const RUNS_MORE = 50

const state = {
  resolution: {} as Loadable<Resolution>,
  list: {} as Loadable<ListData>,
  run: {} as Loadable<Run>,
  place: { tab: 'workflows' } as Place,
  selected: undefined as string | undefined,
  tab: 'logs' as Tab,
  logs: { key: '', value: undefined as LogText | undefined, error: undefined as string | undefined },
  /** The note typed for each gate, by step name; a ticket's one note is under ''. */
  notes: {} as Record<string, string>,
  busy: false,
  actionError: undefined as string | undefined,
  /** The run control whose request runs or ran last, so its button says it is busy and its error shows beside it. */
  acted: undefined as string | undefined,
  /** The run action a first press asked about; a second press on the same action runs it. */
  confirm: undefined as RunAction | undefined,
  /** The Run form, open for one workflow that declares inputs: the text typed for each. */
  form: undefined as { workflow: string; fields: InputField[]; values: Record<string, string> } | undefined,
  search: '',
  /** How the Workflows tab narrows and orders its runs, kept for each repo, and how many of them it draws. */
  runs: ALL_RUNS as RunsView,
  runsLimit: RUNS_FIRST,
  agent: undefined as AgentTerminal | null | undefined,
  flash: undefined as { action: string; text: string } | undefined,
  factories: {} as Loadable<Factories>,
  factoriesAt: 0,
  board: {} as Loadable<Board>,
  filter: 'all' as TicketFilter,
  item: {} as Loadable<Decided>,
  itemTab: 'now' as ItemTab,
  productOpen: {} as Record<string, boolean>,
  studio: { url: undefined as string | undefined, error: undefined as string | undefined },
  theme: 'orca' as ThemeId,
  themeMenu: false,
  /** The workspace being switched to, while the panel asks which repo it uses; nothing of the last repo shows meanwhile. */
  switching: undefined as string | undefined,
  /** The panel is asking again which repo this workspace uses and what it holds, behind what it shows. */
  refreshing: false,
  /** What waits for the person in every repo. It belongs to no repo, so a change of repo or workspace leaves it. */
  inbox: {} as Loadable<Inbox>,
  inboxAt: 0,
  inboxReading: false,
  inboxOn: true,
  /** A repo opened from the inbox, on screen in place of the focused workspace's until the person goes back. */
  visiting: undefined as { repo: Repo; label: string } | undefined,
  connect: newConnect()
}

type Fault = Extract<Connected, { ok: false }>
/**
 * The two forms that connect Swampling to a server over SSH, and what the last press on them came to. The login form
 * asks for an SSH login; the folder form asks where the repo is on a login that is already saved.
 */
type Connect = {
  /** The login form shows outside the first card: opened from the gear menu, the link under the repos, or Change SSH login. */
  open: boolean
  /** The login typed. Undefined until the person types, so the address Orca connects to shows as the suggestion. */
  login: string | undefined
  /** The saved login the typed one takes the place of. */
  replaces?: SshHost
  /** Whether the steps that set up an SSH key show under the login form. */
  help: boolean
  folder: { open: boolean; dir: string; on?: SshHost }
  /** The form whose request is out, with the login it asks. */
  pending?: { form: 'login' | 'folder'; login: string }
  fault?: Fault & { form: 'login' | 'folder' }
  /** A request that failed with no fault to name, in the worker's words. */
  error?: { form: 'login' | 'folder'; message: string }
  /** The login connected last, for the confirmation over its repos. */
  done?: SshHost
  /** One line under the header that says what the last press did. */
  note?: { text: string; tone: 'ok' | 'fail' | 'muted' }
}
function newConnect(): Connect {
  return { open: false, login: undefined, help: false, folder: { open: false, dir: '' } }
}

/** What the panel last read from one repo: the parts of `state` that may only show under that repo's header. */
type RepoData = Pick<typeof state, 'list' | 'run' | 'factories' | 'factoriesAt' | 'board' | 'item'>
const noData = (): RepoData => ({ list: {}, run: {}, factories: {}, factoriesAt: 0, board: {}, item: {} })
// ponytail: the 10 repos left last keep their data, in memory only; any other repo opens on "Asking swamp…".
const DATA_KEPT = 10
const repoData = new Map<string, RepoData>()

// Each repo keeps the place the person was last at, so coming back to a repo opens there. The places live in
// localStorage, because the frame can reload when Orca remounts the panel.
const PLACE_KEY = 'swampling.place'
let places: Places = []
/** The repo `state.place` is a place in, and whose data `state` holds. */
let placeOf: string | undefined
// The repo each workspace resolved to last, shown at once on a switch back while the worker is asked again.
const RESOLUTIONS_KEY = 'swampling.resolutions'
let resolutions: Resolutions = []
function restorePlace(): void {
  try {
    places = parsePlaces(JSON.parse(localStorage.getItem(PLACE_KEY) ?? '[]'))
  } catch {}
  try {
    resolutions = parseResolutions(JSON.parse(localStorage.getItem(RESOLUTIONS_KEY) ?? '[]'))
  } catch {}
  // Until the repo is known, the panel starts where it was last, which is right for a plain frame reload.
  const last = places.at(-1)
  if (last) [state.place, placeOf, state.runs] = [last.place, last.repo, last.runs ?? ALL_RUNS]
}
function savePlace(): void {
  if (!placeOf) return
  places = withPlace(places, placeOf, state.place, state.runs)
  try {
    localStorage.setItem(PLACE_KEY, JSON.stringify(places))
  } catch {}
}

const placeAttr = (place: Place): string => `data-place="${esc(JSON.stringify(place))}"`
/** The attributes of a button that goes to `place`. */
const goTo = (place: Place): string => `data-action="go" ${placeAttr(place)}`

// The worker's settings file is the record; this copy only paints the saved theme before the worker answers.
const THEME_KEY = 'swampling.theme'
function applyTheme(id: ThemeId): void {
  state.theme = id
  if (id === 'orca') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = id
  try {
    localStorage.setItem(THEME_KEY, id)
  } catch {}
}
function savedThemeHint(): ThemeId {
  try {
    return parseThemeId(localStorage.getItem(THEME_KEY))
  } catch {
    return 'orca'
  }
}

const INBOX_ON_KEY = 'swampling.inbox'
/** Turns the "Needs you" tab on or off. Off, the panel asks no repo but the one on screen. */
function applyInbox(on: boolean): void {
  state.inboxOn = on
  try {
    localStorage.setItem(INBOX_ON_KEY, String(on))
  } catch {}
  if (!on && state.place.tab === 'inbox') go(home('workflows'))
  else render()
}
function savedInboxHint(): boolean {
  try {
    return localStorage.getItem(INBOX_ON_KEY) !== 'false'
  } catch {
    return true
  }
}

// Asked again on each refresh until it answers: right after a plugin reload the worker may not be up yet.
let themeSynced = false
let inboxSynced = false
function syncTheme(): void {
  if (!inboxSynced)
    orca.plugin.request('inbox.enabled', {}).then(({ on }) => {
      if (inboxSynced) return
      inboxSynced = true
      if (on !== state.inboxOn) applyInbox(on)
    }, () => {})
  if (themeSynced) return
  orca.plugin.request('theme.get', {}).then(({ theme }) => {
    if (themeSynced) return
    themeSynced = true
    if (theme !== state.theme) {
      applyTheme(theme)
      render()
    }
  }, () => {})
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function failure(e: unknown): { code: string; message: string } {
  const err = e as { code?: string; message?: string }
  return { code: err.code ?? 'swamp_error', message: err.message ?? String(e) }
}

const TONE_VAR: Record<Tone, string> = { ok: 'var(--ok)', fail: 'var(--fail)', run: 'var(--run)', wait: 'var(--gold)', warm: 'var(--warm)', muted: 'var(--muted)' }

const LOGO = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 22V9"/><rect x="10" y="3" width="4" height="7" rx="2"/><path d="M7 22c0-5-2-8-4-10"/><path d="M17 22c0-5 2-8 4-10"/></svg>`
const EXTERNAL = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v6H4V6h6"/></svg>`
const GEAR = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`
const CHECK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`
const REFRESH = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>`

function icon(step: Step | { status: 'waiting' }, size = 18): string {
  const a = (label: string) => `width="${size}" height="${size}" viewBox="0 0 18 18" role="img" aria-label="${label}"`
  switch (step.status) {
    case 'succeeded':
      return `<svg ${a('Succeeded')}><circle cx="9" cy="9" r="8" fill="var(--ok)"/><path d="M5.5 9.2l2.3 2.3 4.7-4.8" fill="none" stroke="var(--panel)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    case 'failed':
      return `<svg ${a('Failed')}><circle cx="9" cy="9" r="8" fill="var(--fail)"/><path d="M6.2 6.2l5.6 5.6M11.8 6.2l-5.6 5.6" stroke="var(--panel)" stroke-width="2" stroke-linecap="round"/></svg>`
    case 'waiting':
      return `<svg ${a('Waiting on a person')}><rect x="3.5" y="3.5" width="11" height="11" transform="rotate(45 9 9)" fill="var(--gold)"/></svg>`
    case 'skipped':
      return `<svg ${a('Skipped')}><circle cx="9" cy="9" r="7" fill="none" stroke="var(--dim)" stroke-width="2"/><path d="M5 9h8" stroke="var(--dim)" stroke-width="2"/></svg>`
    case 'running':
    case 'resuming':
      return `<svg ${a(step.status === 'running' ? 'Running' : 'Approved, resuming')} class="spin"><circle cx="9" cy="9" r="7" fill="none" stroke="var(--dim)" stroke-width="2"/><path d="M9 2a7 7 0 0 1 7 7" fill="none" stroke="var(--run)" stroke-width="2" stroke-linecap="round"/></svg>`
    default:
      return `<svg ${a('Pending')}><circle cx="9" cy="9" r="7" fill="none" stroke="var(--dim)" stroke-width="2"/></svg>`
  }
}

const diamond = (size: number) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 18 18" aria-hidden="true"><rect x="3.5" y="3.5" width="11" height="11" transform="rotate(45 9 9)" fill="var(--gold)"/></svg>`

const pill = (tone: Tone, text: string, size = 12) =>
  `<span class="pill" style="font-size:${size}px;color:${TONE_VAR[tone]};border-color:${TONE_VAR[tone]}">${esc(text)}</span>`

const THEME_LOOK: Record<ThemeId, { label: string; blurb: string; swatch: string[] }> = {
  orca: { label: 'Follow Orca', blurb: 'Your Orca colors, light or dark', swatch: ['var(--orca-background)', 'var(--orca-primary)', ORCA_STATUS.dark.ok, ORCA_STATUS.dark.fail, ORCA_STATUS.dark.gold] },
  ...(Object.fromEntries(
    Object.entries(PALETTES).map(([id, p]) => [id, { label: p.label, blurb: p.blurb, swatch: [p.tokens.panel, p.tokens.accent, p.tokens.ok, p.tokens.fail, p.tokens.gold] }])
  ) as Record<Exclude<ThemeId, 'orca'>, { label: string; blurb: string; swatch: string[] }>)
}

function themeMenu(): string {
  return `<div class="theme-menu" role="menu" aria-label="Panel theme">
    ${THEME_IDS.map((id) => {
      const { label, blurb, swatch } = THEME_LOOK[id]
      const [bg, ...dots] = swatch
      return `<button role="menuitemradio" tabindex="-1" class="theme-item" id="theme-${id}" aria-checked="${state.theme === id}" data-action="theme" data-theme="${id}">
        <span class="swatch" style="background:${bg}" aria-hidden="true">${dots.map((c) => `<span style="background:${c}"></span>`).join('')}</span>
        <span style="flex:1;min-width:0"><span style="display:block;font-weight:500">${esc(label)}</span><span class="muted" style="display:block;font-size:11.5px">${esc(blurb)}</span></span>
        <span class="theme-check">${state.theme === id ? CHECK : ''}</span>
      </button>`
    }).join('')}
    <button role="menuitemcheckbox" tabindex="-1" class="theme-item" style="border-top:1px solid var(--border)" aria-checked="${state.inboxOn}" data-action="inboxToggle">
      <span style="flex:1;min-width:0"><span style="display:block;font-weight:500">Needs you tab</span><span class="muted" style="display:block;font-size:11.5px">One list of what waits for you in all your repos</span></span>
      <span class="theme-check">${state.inboxOn ? CHECK : ''}</span>
    </button>
    ${loginsMenu()}
  </div>`
}

/** The gear menu's part for the SSH logins the person added. It shows once there is a login, or a server that needs one. */
function loginsMenu(): string {
  const res = state.resolution.data
  const logins = res?.logins ?? []
  if (!logins.length && !res?.sshless?.length) return ''
  return `<div class="menu-label" id="logins-label">SSH logins</div>
    ${logins
      .map(
        (h) => `<div class="menu-row"><span class="mono ellipsis" style="flex:1">${esc(h)}</span>
          <button role="menuitem" tabindex="-1" class="btn-outline ctl" data-action="loginRemove" data-host="${esc(h)}" aria-label="Remove ${esc(h)}">Remove</button></div>`
      )
      .join('')}
    <button role="menuitem" tabindex="-1" class="theme-item" data-action="loginAdd"><span style="font-weight:500">Add an SSH login…</span></button>`
}

const repoDir = (): Repo | null => state.visiting?.repo ?? state.resolution.data?.repo ?? null
const factoryOf = (p: Place): string | undefined => ('factory' in p ? p.factory : undefined)
const itemOf = (p: Place): string | undefined => ('item' in p ? p.item : undefined)


function header(): string {
  const res = state.resolution.data
  const dir = repoDir()
  const key = dir ? repoKey(dir) : ''
  const current = res?.candidates.find((c) => repoKey(c.repo) === key)
  const label = state.visiting?.label ?? (current ? repoTitle(current) : key)
  const reading = state.refreshing || (state.inboxReading && state.place.tab === 'inbox')
  const version = state.list.data?.version ? ` · swamp ${esc(state.list.data.version.split('.')[0])}` : ''
  const picker =
    !state.visiting && res?.repo && res.candidates.length > 1
      ? `<select class="repo-select" data-change="pick" aria-label="Swamp repo">${res.candidates
          .map((c) => `<option value="${esc(repoKey(c.repo))}" ${repoKey(c.repo) === key ? 'selected' : ''}>${esc(repoTitle(c))}</option>`)
          .join('')}</select>`
      : `<span class="ellipsis">${esc(label)}</span>`
  return `<header class="app-head">
    ${LOGO}
    <div style="flex:1;min-width:0">
      <div style="font-weight:600;font-size:14px">Swampling</div>
      <div class="muted" style="font-size:12px;display:flex;align-items:center">${picker}<span style="white-space:nowrap">${version ? `&nbsp;${version.slice(1)}` : ""}</span></div>
    </div>
    <button class="icon-btn" data-action="refresh" aria-label="Refresh" aria-busy="${reading}">${reading ? REFRESH.replace('<svg ', '<svg class="spin" ') : REFRESH}</button>
    <button class="icon-btn" id="theme-btn" data-action="themeMenu" aria-label="Theme" aria-haspopup="menu" aria-expanded="${state.themeMenu}">${GEAR}</button>
    ${state.themeMenu ? themeMenu() : ''}
  </header>${
    state.visiting
      ? `<div class="stale" style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span style="flex:1">Showing <b>${esc(state.visiting.label)}</b>, opened from Needs you. It is not this workspace's repo.</span>
          <button class="btn-outline" style="min-height:28px;padding:0 10px;flex-shrink:0" data-action="leave">Back</button>
        </div>`
      : ''
  }${state.connect.note ? `<div class="stale note-${state.connect.note.tone}" role="status" style="margin-bottom:10px">${esc(state.connect.note.text)}</div>` : ''}${
    state.connect.open && !firstCard() ? `<div style="padding:0 16px 10px">${loginCard()}</div>` : ''
  }`
}

function errorBox(e: { code: string; message: string }): string {
  const res = state.resolution.data
  if (e.code === 'not_a_swamp_repo' && res) return repoPicker('This folder is not a swamp repo', res)
  const repo = repoDir()
  if (e.code === 'host_unreachable' && repo?.kind === 'ssh') return downCard(repo.host, e.message, repo)
  const missing = e.code === 'swamp_not_found'
  return `<div class="card" style="border-color:var(--fail);background:var(--fail-bg);display:flex;flex-direction:column;gap:8px">
    <div style="font-weight:600">${missing ? 'swamp CLI not found' : esc(PROBLEM_TITLE[e.code] ?? 'swamp failed')}</div>
    <div class="muted" style="line-height:1.5;overflow-wrap:anywhere">${esc(e.message)}</div>
    ${missing ? '<div class="muted" style="font-size:12px">Install swamp so it is on your PATH or in ~/.local/bin, then retry.</div>' : ''}
    <div><button class="btn-outline" data-action="refresh" style="min-height:32px;padding:0 12px">Retry</button></div>
  </div>`
}

/** A saved login that cannot be reached now. `why` is the cause in plain words, with ssh's own line last; a login the person added can be changed here. */
function downCard(login: SshHost, why: string, repo?: Repo): string {
  const [cause, said] = why.split(' ssh said: ')
  const mine = state.resolution.data?.logins?.includes(login)
  return `<div class="card" style="border-color:var(--fail);background:var(--fail-bg);display:flex;flex-direction:column;gap:8px">
    <div style="font-weight:600">Cannot reach ${esc(login)} right now</div>
    <div style="line-height:1.5">${repo ? `${esc(repo.dir.split('/').pop())} is read from ${esc(login)} over SSH, and ${esc(login)} could not be reached. ` : ''}Your setup is kept.</div>
    <div class="muted" style="font-size:12px;line-height:1.5">${esc(cause)}</div>
    ${said ? `<div class="said">ssh said: ${esc(said)}</div>` : ''}
    <div class="ctls"><button class="btn-outline" data-action="refresh" style="min-height:32px;padding:0 12px">Retry</button>
      ${mine ? `<button class="btn-outline" data-action="loginChange" data-host="${esc(login)}" style="min-height:32px;padding:0 12px">Change SSH login</button>` : ''}</div>
  </div>`
}

const SPINNER = `<svg width="16" height="16" viewBox="0 0 18 18" class="spin" aria-hidden="true" style="flex-shrink:0"><circle cx="9" cy="9" r="7" fill="none" stroke="var(--dim)" stroke-width="2"/><path d="M9 2a7 7 0 0 1 7 7" fill="none" stroke="var(--muted)" stroke-width="2" stroke-linecap="round"/></svg>`

const listOf = (names: string[]): string => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`)

/** The login field's text: what the person typed, or the one address Orca connects to. */
const loginText = (): string => {
  const servers = state.resolution.data?.sshless ?? []
  return state.connect.login ?? (servers.length === 1 ? (servers[0].address ?? '') : '')
}

// The commands name the login only when it is one: what is typed is never put into a command as it is.
function keyHelp(login: string, address?: string): string {
  const to = sshHostOf(login) ?? `user@${address ?? 'server'}`
  return `<ol class="steps">${keySteps(to)
    .map((step, i) => `<li>${esc(step.say)}${copyRow(step.run, `key-${i}`)}</li>`)
    .join('')}</ol><div class="muted" style="font-size:12px">Then press Connect.</div>`
}

function faultHtml(form: 'login' | 'folder', address?: string): string {
  const { fault, error } = state.connect
  if (error?.form === form) return `<div class="ctl-error" role="alert" id="${form}-error">${esc(error.message)}</div>`
  if (fault?.form !== form) return ''
  const says = FAULT_SAYS[fault.fault]({ login: fault.login, folder: fault.folder, address })
  return `<div class="ctl-error" role="alert" id="${form}-error">${esc(says.text)}</div>
    ${says.run ? copyRow(says.run, 'fault-run') : ''}
    ${says.keys ? keyHelp(fault.login, address) : ''}
    ${fault.said ? `<div class="said">ssh said: ${esc(fault.said)}</div>` : ''}`
}

const busyRow = (text: string): string =>
  `<div class="ctls" style="align-items:center" role="status">${SPINNER}<span style="flex:1;min-width:0"><span style="display:block">${esc(text)}</span><span class="muted" style="font-size:12px">Up to 20 seconds.</span></span>
    <button type="button" class="btn-outline" style="min-height:38px;padding:0 14px" data-action="connectCancel">Cancel</button></div>`

/** The form that asks for an SSH login. `servers` are the ones Orca reaches without SSH, whose addresses it offers. */
function loginForm(servers: CodeServer[]): string {
  const c = state.connect
  const text = loginText()
  const pending = c.pending?.form === 'login' ? c.pending : undefined
  const one = servers.length === 1 ? servers[0] : undefined
  const address = one?.address
  const user = state.resolution.data?.sshUser
  const offered = one ? [] : servers.filter((x) => x.address)
  return `<form class="run-form" data-form="login" novalidate>
    <label for="login-field" style="font-weight:600">${one ? `SSH login for ${esc(one.name)}` : 'SSH login'}</label>
    ${
      offered.length
        ? `<div class="chips" role="group" aria-label="Addresses Orca connects to">${offered.map((x) => `<button type="button" class="fchip tight" data-action="loginUse" data-login="${esc(x.address)}" ${pending ? 'disabled' : ''}>${esc(x.name)}: ${esc(x.address)}</button>`).join('')}</div>`
        : ''
    }
    <input class="note" id="login-field" data-input="login" value="${esc(text)}" placeholder="dev@${esc(address ?? 'server.example')}" required aria-describedby="login-error login-help" autocapitalize="off" autocomplete="off" spellcheck="false" ${pending ? 'disabled' : ''}>
    ${faultHtml('login', address)}
    <div class="muted" id="login-help" style="font-size:12px;line-height:1.45">What you would type after <span class="mono">ssh</span> in a terminal, such as <span class="mono">dev@${esc(address ?? 'server.example')}</span> or a name from your SSH config.${
      address ? ` Orca connects to ${esc(one!.name)} at <span class="mono">${esc(address)}</span>.` : offered.length ? ' Pick a server above to fill in the address Orca connects to.' : ''
    }${user ? ` Without a user name, ssh logs in as <span class="mono">${esc(user)}</span>.` : ''}</div>
    ${
      pending
        ? busyRow(`Connecting to ${pending.login}…`)
        : `<div class="ctls"><button type="submit" class="btn-accent" style="padding:0 18px" ${text.trim() ? '' : 'disabled'}>Connect</button>
            ${c.open ? '<button type="button" class="btn-outline" style="min-height:38px;padding:0 14px" data-action="loginClose">Close</button>' : ''}</div>`
    }
    ${
      c.fault?.form === 'login' && FAULT_SAYS[c.fault.fault](c.fault).keys
        ? ''
        : `<div><button type="button" class="link" data-action="keyHelp" aria-expanded="${c.help}">No SSH login to this server yet?</button></div>${c.help ? keyHelp(tidyLogin(text), address) : ''}`
    }
  </form>`
}

function folderForm(logins: SshHost[]): string {
  const c = state.connect
  const on = c.folder.on && logins.includes(c.folder.on) ? c.folder.on : logins[0]
  const pending = c.pending?.form === 'folder' ? c.pending : undefined
  return `<form class="run-form" data-form="folder" novalidate>
    <label for="folder-field" style="font-weight:600">Folder of the repo on ${logins.length > 1 ? '' : esc(on)}</label>
    ${
      logins.length > 1
        ? `<select class="note" data-change="folderOn" aria-label="SSH login" ${pending ? 'disabled' : ''}>${logins.map((h) => `<option value="${esc(h)}" ${h === on ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select>`
        : ''
    }
    <input class="note" id="folder-field" data-input="folder" value="${esc(c.folder.dir)}" placeholder="/srv/factory" required aria-describedby="folder-error folder-help" autocapitalize="off" autocomplete="off" spellcheck="false" ${pending ? 'disabled' : ''}>
    ${faultHtml('folder')}
    <div class="muted" id="folder-help" style="font-size:12px;line-height:1.45">The full path, such as <span class="mono">/srv/factory</span> or <span class="mono">~/factory</span>. Swampling finds the swamp repo at that folder or above it.</div>
    ${pending ? busyRow(`Looking on ${pending.login}…`) : `<div class="ctls"><button type="submit" class="btn-accent" style="padding:0 18px" ${c.folder.dir.trim() ? '' : 'disabled'}>Find repo</button></div>`}
  </form>`
}

const card = (title: string, body: string, more = ''): string =>
  `<div class="card" style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">
    <div style="font-weight:600">${title}</div>
    <div class="muted" style="line-height:1.5">${body}</div>${more}
  </div>`

/** Whether the picker's first card is the connect form, so the form does not also show under the header. */
const firstCard = (): boolean => {
  const res = state.resolution.data
  return !!res && state.switching === undefined && !repoDir() && pickerNotice(res, state.connect.done)?.kind === 'connect'
}

/** The login form on its own card: opened from the gear menu, the link under the repos, or Change SSH login. */
function loginCard(): string {
  const old = state.connect.replaces
  return card(
    old ? `Change the SSH login ${esc(old)}` : 'Add an SSH login',
    old
      ? `Connect with another login in place of ${esc(old)}. Repos picked on ${esc(old)} move to the new login where it has them.`
      : 'For a server Orca reaches with a pairing code. Swampling reads the swamp repos there through this login.',
    loginForm(state.resolution.data?.sshless ?? [])
  )
}

function noticeCard(n: PickerNotice | null, res: Resolution): string {
  if (!n) return ''
  if (n.kind === 'connect') {
    const names = n.servers.map((x) => x.name)
    const one = names.length === 1 ? esc(names[0]) : undefined
    const where = n.workspace ? esc(n.workspace) : 'This workspace'
    return card(
      one ? `Connect Swampling to ${one}` : 'Connect Swampling to a server',
      one
        ? `${where} is on the server ${one}. Orca reaches ${one} with a pairing code, but Swampling needs its own SSH login there to read the swamp repo. Your Orca pairing is not changed.`
        : `${where} is on one of the servers ${esc(listOf(names))}. Orca reaches them with a pairing code, but Swampling needs its own SSH login on that server to read the swamp repo. Your Orca pairing is not changed.`,
      `${
        n.offline === undefined
          ? ''
          : `<div class="stale" style="margin:0" role="status">Orca cannot reach ${n.offline ? `the server ${esc(n.offline)}` : 'a server'} right now. If it is off, Connect will not reach it either.</div>`
      }${loginForm(n.servers)}`
    )
  }
  if (n.kind === 'connected') return card(`Connected to ${esc(n.login)}`, 'Pick the swamp repo this workspace uses.')
  if (n.kind === 'no-repos') {
    return card(
      n.connected ? `Connected to ${esc(n.login)}, but no repos are listed there` : `No repos are listed on ${esc(n.login)}`,
      `swamp on ${esc(n.login)} has no repo in its list. Type the folder of your repo there and Swampling finds it.`,
      folderForm(res.logins ?? [n.login])
    )
  }
  if (n.kind === 'login-down') return `<div style="margin-bottom:12px">${downCard(n.fault.login, sayPlain(FAULT_SAYS[n.fault.cause]({ login: n.fault.login }), n.fault.said))}</div>`
  if (n.kind === 'problem') {
    return `<div class="card" style="border-color:var(--fail);background:var(--fail-bg);display:flex;flex-direction:column;gap:6px;margin-bottom:12px">
      <div style="font-weight:600">Remote repos: ${esc(n.title)}</div>
      <div class="muted" style="line-height:1.5;overflow-wrap:anywhere">${esc(n.message)}</div>
      <div><button class="btn-outline" data-action="refresh" style="min-height:32px;padding:0 12px">Retry</button></div>
    </div>`
  }
  if (n.kind === 'shared') {
    return card(
      `${n.count} workspaces are named ${esc(n.name)}`,
      'Orca tells plugins which one is focused only through its terminals, and this one has none. Open a terminal in it and the panel finds its repo, or pick one below for now.'
    )
  }
  if (n.kind === 'unlisted') {
    return card(
      `${esc(n.name)} is not visible to plugins`,
      `Orca does not give plugins this workspace, so the panel cannot read its swamp repo. Run <span class="mono">swamp</span> in that workspace's terminal, or pick a repo below.`
    )
  }
  const hosts = esc(n.hosts.join(', '))
  return n.workspace
    ? card(
        `Is ${esc(n.workspace)} a workspace on ${hosts}?`,
        'Orca does not tell plugins where this workspace is, so it is probably on a remote host. Pick its swamp repo below; for a remote repo the panel runs swamp there over SSH. The panel remembers the pick for this workspace.'
      )
    : card(
        `Is this a workspace on ${hosts}?`,
        'Orca does not tell plugins which remote workspace is focused. Pick its swamp repo below; the panel runs swamp there over SSH and remembers the pick for remote workspaces.'
      )
}


function repoPicker(title: string, res: Resolution): string {
  const shared = res.workspace?.sharedName
  const logins = res.logins ?? []
  const notice = pickerNotice(res, state.connect.done)
  const kind = notice?.kind
  // These cards are the whole answer while there is no repo to list under them.
  const alone = (kind === 'connect' || kind === 'no-repos' || kind === 'login-down') && !res.candidates.length
  const onLogin = notice?.kind === 'connected' && res.candidates.every((c) => c.repo.kind === 'ssh' && c.repo.host === notice.login) ? `Repos on ${notice.login}` : undefined
  const more = res.remoteHosts && kind !== 'connect' && (logins.length || res.sshless?.length)
  const unlistedLink = logins.length && kind !== 'no-repos' && kind !== 'login-down'
  return `<div class="body">
    ${noticeCard(notice, res)}
    ${
      alone
        ? ''
        : `<section class="section">
      <div class="label">${esc((onLogin ?? (kind === 'connected' ? 'Swamp repos' : title)).toUpperCase())}</div>
      ${
        res.candidates.length === 0
          ? '<div class="muted" style="line-height:1.5">No folder in your Orca workspaces has a <span class="mono">.swamp.yaml</span>. Open a swamp repo as a workspace, then refresh.</div>'
          : `${kind === 'connected' ? '' : `<div class="muted" style="font-size:12px;margin-bottom:4px">Pick the swamp repo this workspace uses.${shared ? '' : ' The panel remembers it.'}</div>`}
             ${res.candidates
               .map(
                 (c) => `<button class="card row-btn" data-action="pick" data-key="${esc(repoKey(c.repo))}">
                   ${LOGO}<span style="flex:1;min-width:0;text-align:left"><span class="mono" style="font-weight:600">${esc(repoTitle(c))}</span><br><span class="muted" style="font-size:12px;overflow-wrap:anywhere">${esc(repoKey(c.repo))}</span></span></button>`
               )
               .join('')}`
      }
    </section>`
    }
    ${
      more
        ? `<div class="ctls" style="gap:4px 16px">
            ${unlistedLink ? `<button class="link" data-action="folderToggle" aria-expanded="${state.connect.folder.open}">My repo is not listed</button>` : ''}
            ${state.connect.open ? '' : '<button class="link" data-action="loginAdd">Add an SSH login</button>'}
          </div>
          ${unlistedLink && state.connect.folder.open ? folderForm(logins) : ''}`
        : ''
    }
  </div>`
}

const matches = (...fields: (string | undefined)[]) => {
  const q = state.search.trim().toLowerCase()
  return !q || fields.some((f) => f?.toLowerCase().includes(q))
}

const runTone = (s: RunStatus): string => TONE_VAR[runLook(s).tone]

const off = (): string => (state.busy ? 'disabled' : '')
/** A run control's label, or what it is doing while its request runs. */
const controlText = (id: string, label: string, busy: string): string => esc(state.busy && state.acted === id ? busy : label)
const controlError = (id: string): string => (state.actionError && state.acted === id ? `<div class="ctl-error">${esc(state.actionError)}</div>` : '')

/** Run on a workflow: it starts at once, or opens the form when the workflow declares inputs. */
const runButton = (workflow: string): string =>
  `<button class="btn-outline ctl" data-action="run" data-workflow="${esc(workflow)}" title="Start a new run" ${off()}>${controlText(`run:${workflow}`, 'Run', 'Asking swamp…')}</button>`

/** The open Run form of `workflow`: one field per declared input, the required ones marked, the defaults filled in. */
function runForm(workflow: string): string {
  const form = state.form
  if (form?.workflow !== workflow) return ''
  const field = (f: InputField) => {
    const attrs = `class="note" id="input-${esc(f.name)}" data-input="field" data-field="${esc(f.name)}" ${f.required ? 'required' : ''} ${off()}`
    const value = form.values[f.name] ?? ''
    const control = f.options
      ? `<select ${attrs}>${['', ...f.options].map((o) => `<option value="${esc(o)}" ${o === value ? 'selected' : ''}>${esc(o || (f.required ? 'Choose…' : 'Default'))}</option>`).join('')}</select>`
      : `<input ${attrs} value="${esc(value)}" ${f.type === 'string' ? '' : `placeholder="${esc(f.type)}"`}>`
    return `<label class="field"><span><span class="mono" style="color:var(--text)">${esc(f.name)}</span>${f.required ? ' <span style="color:var(--gold)">required</span>' : ''}</span>
      ${control}
      ${f.description ? `<span style="font-size:11.5px;line-height:1.4">${esc(f.description)}</span>` : ''}</label>`
  }
  return `<div class="run-form">
    ${form.fields.map(field).join('')}
    <div class="ctls">
      <button class="btn-accent ctl" style="padding:0 14px" data-action="runStart" ${off()}>${controlText(`run:${workflow}`, 'Start run', 'Starting…')}</button>
      <button class="btn-outline ctl" data-action="runClose" ${off()}>Cancel</button>
    </div>
  </div>`
}

function workflowCard(w: WorkflowSummary, now: number, usual?: number): string {
  const look = w.latest ? runLook(w.latest.status) : { tone: 'muted' as Tone, text: 'Never run' }
  const history = w.runs.map((r) => r.status).reverse()
  const bars = [...Array(Math.max(0, 10 - history.length)).fill('none'), ...history]
  const counts = ['succeeded', 'failed', 'suspended'].map((s) => history.filter((h) => h === s).length)
  return `<${w.latest ? 'button' : 'div'} class="card wf" ${w.latest ? goTo({ tab: 'workflows', workflow: w.name }) : ''}>
    <div style="display:flex;align-items:center;gap:8px">
      <span class="mono" style="font-weight:600" title="${esc(w.name)}">${esc(shortName(w.name))}</span>
      <span style="margin-left:auto">${pill(look.tone, look.text, 11.5)}</span>
    </div>
    ${w.description ? `<div class="muted clamp" style="font-size:12px;line-height:1.45">${esc(w.description)}</div>` : ''}
    <div style="display:flex;gap:3px" role="img" aria-label="Last ${history.length} runs: ${counts[0]} passed, ${counts[1]} failed, ${counts[2]} waiting">
      ${bars.map((h) => `<span class="bar" style="background:${h === 'none' ? 'var(--dim-fill)' : runTone(h)}"></span>`).join('')}
    </div>
    <div class="muted" style="display:flex;gap:12px;font-size:12px">
      <span>${w.steps} step${w.steps === 1 ? '' : 's'}</span>${w.latest?.trigger ? `<span>${esc(w.latest.trigger)}</span>` : ''}${usual === undefined ? '' : `<span title="The median of its latest passed runs">usually ${brief(usual)}</span>`}
      <span style="margin-left:auto">${w.latest ? ago(w.latest.startedAt, now) : ''}</span>
    </div>
    ${w.latest ? '' : `<div class="ctls">${runButton(w.name)}</div>${runForm(w.name)}${controlError(`run:${w.name}`)}`}
  </${w.latest ? 'button' : 'div'}>`
}

/** One row of a RECENT RUNS list; the current one is not a link. */
function recentRow(o: { place: Place | null; color: string; name: string; detail: string; status: string }): string {
  const tag = o.place ? 'button' : 'div'
  return `<${tag} class="recent" ${o.place ? goTo(o.place) : 'aria-current="true"'}>
    <span class="dot" style="background:${o.color}" aria-hidden="true"></span>
    <span class="mono" style="font-size:12px">${esc(o.name)}</span>
    <span class="muted ellipsis" style="font-size:12px">${esc(o.detail)}</span>
    <span class="muted" style="margin-left:auto;font-size:12px;white-space:nowrap">${esc(o.status)}</span>
  </${tag}>`
}

/** A run's color and what its row says of its pace; a run in flight that is slow, quiet or gone takes that pace's color. */
function rowPace(r: RecentRun, now: number, usual?: number): { color: string; text?: string } {
  const pace = paceOf(r, usual, now)
  return { color: pace && pace.state !== 'on-pace' ? TONE_VAR[PACE_LOOK[pace.state].tone] : runTone(r.status), text: pace && paceRow(pace) }
}

function runRow(r: RecentRun, name: string, now: number, usual?: number, current?: RunId): string {
  const pace = rowPace(r, now, usual)
  return recentRow({
    place: r.runId === current ? null : { tab: 'workflows', workflow: r.workflow, runId: r.runId },
    color: pace.color,
    name,
    detail: r.input ?? shortId(r.runId),
    status: `${runLook(r.status).text.toLowerCase()} · ${pace.text ?? since(r.startedAt, now)}`
  })
}

/** One run under its workflow's heading: what it ran on, then its id, how it ended and how long it took. */
function runLine(r: RecentRun, now: number, usual?: number): string {
  const look = runLook(r.status)
  const pace = rowPace(r, now, usual)
  const ended = look.text.toLowerCase() + (r.status === 'failed' && r.failedStep ? ` at ${r.failedStep}` : '')
  const facts = [r.input && shortId(r.runId), ended, pace.text ?? duration(r.durationMs)].filter(Boolean)
  return `<button class="recent" ${goTo({ tab: 'workflows', workflow: r.workflow, runId: r.runId })}>
    <span class="dot" style="background:${pace.color}" aria-hidden="true"></span>
    <span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
      <span class="mono ellipsis" style="font-size:12px">${esc(r.input ?? shortId(r.runId))}</span>
      <span class="muted ellipsis" style="font-size:11.5px">${esc(facts.join(' · '))}</span>
    </span>
    <span class="muted" style="font-size:12px;white-space:nowrap">${ago(r.startedAt, now)}</span>
  </button>`
}

/** The status chips with their counts, the time window, and the sort, which one button steps through. */
function runControls(counts: Record<RunsView['status'], number>): string {
  const v = state.runs
  const chip = (part: Partial<RunsView>, on: boolean, color: string, html: string, more = '') =>
    `<button class="fchip tight" aria-pressed="${on}" style="--c:${color}" data-action="runs" data-view="${esc(JSON.stringify(part))}" ${more}>${html}</button>`
  const sorts = Object.keys(RUN_SORTS) as RunsView['sort'][]
  const next = sorts[(sorts.indexOf(v.sort) + 1) % sorts.length]
  return `<div style="display:flex;flex-direction:column;gap:6px">
    <div class="chips" role="group" aria-label="Run status">
      ${(Object.keys(RUN_CHIPS) as RunsView['status'][])
        .map((s) => chip({ status: s }, v.status === s, s === 'all' ? 'var(--accent)' : TONE_VAR[RUN_CHIPS[s].tone], `${RUN_CHIPS[s].label} <span class="n">${counts[s]}</span>`))
        .join('')}
    </div>
    <div class="chips" role="group" aria-label="Run time and order">
      ${(Object.keys(WHEN_LABEL) as RunsView['when'][]).map((w) => chip({ when: w }, v.when === w, 'var(--accent)', WHEN_LABEL[w])).join('')}
      ${chip({ sort: next }, v.sort !== 'newest', 'var(--accent)', `Sort: ${RUN_SORTS[v.sort].label}`, `id="sort" title="Change the order to ${RUN_SORTS[next].label.toLowerCase()}"`)}
    </div>
  </div>`
}

function listScreen(data: ListData): string {
  const now = Date.now()
  const view = state.runs
  const gates = data.gates.filter((g) => matches(g.workflow, g.step, g.input))
  const { runs, counts } = runsShown(data.runs, view, state.search, now)
  const searching = !!state.search.trim()
  const filtering = searching || view.status !== 'all' || view.when !== 'all'
  const workflows = workflowsShown(data.workflows, runs, view, state.search)
  const usual = usualTimes(data.runs)
  const cards =
    workflows.length === 0
      ? filtering && data.workflows.length
        ? ''
        : `<section class="section"><div class="label">WORKFLOWS · 0</div><div class="muted">This repo has no workflows yet.</div></section>`
      : groupWorkflows(workflows)
          .map(
            (g) => `<section class="section">
        <div class="label">${esc(g.title.toUpperCase())} · ${g.workflows.length}</div>
        ${g.workflows.map((w) => workflowCard(w, now, usual.get(w.name))).join('')}
      </section>`
          )
          .join('')
  const list = runs.length
    ? `<section class="section" style="gap:2px">
        <div class="label" style="margin-bottom:6px">RUNS · ${runs.length}</div>
        ${runGroups(runs, state.runsLimit)
          .map((g) => `<div class="label mono" style="margin-top:10px" title="${esc(g.workflow)}">${esc(shortName(g.workflow))}</div>${g.runs.map((r) => runLine(r, now, usual.get(g.workflow))).join('')}`)
          .join('')}
        ${runs.length > state.runsLimit ? `<button class="btn-outline" style="min-height:32px;margin-top:8px" data-action="moreRuns">Show more · ${runs.length - state.runsLimit} left</button>` : ''}
      </section>`
    : filtering
      ? `<section class="section">${workflows.length ? '<div class="label">RUNS · 0</div>' : ''}<div class="muted">No ${workflows.length ? 'run' : 'workflow or run'} matches.</div>
          <button class="btn-outline" style="min-height:32px;padding:0 12px;align-self:flex-start" data-action="clearRuns">Clear filters</button></section>`
      : ''
  return `<div class="body" style="gap:18px">
    <div style="display:flex;flex-direction:column;gap:8px">
      <label><span class="sr">Search workflows and runs</span>
        <input id="search" type="search" class="input" placeholder="Search workflows, runs and inputs" value="${esc(state.search)}" data-input="search">
      </label>
      ${runControls(counts)}
    </div>
    ${
      gates.length
        ? `<section class="section">
        <div class="label" style="color:var(--gold)">WAITING FOR YOU · ${gates.length}</div>
        ${gates
          .map(
            (g) => `<div class="card" style="border-color:var(--gold);background:var(--gold-bg);display:flex;align-items:center;gap:10px">
            ${diamond(14)}
            <div style="flex:1;min-width:0">
              <div style="font-weight:600">${esc(g.workflow)} › ${esc(g.step)}</div>
              <div class="muted" style="font-size:12px">${esc(g.input ?? `run ${shortId(g.runId)}`)} · ${g.expired ? 'expired' : `waiting ${since(g.since, now)}`}</div>
            </div>
            <button class="btn-gold" style="min-height:32px;padding:0 12px" ${goTo({ tab: 'workflows', workflow: g.workflow, runId: g.runId })}>Review</button>
          </div>`
          )
          .join('')}
      </section>`
        : ''
    }
    ${cards + list}
  </div>`
}

const verdicts = (html: string): string =>
  html
    .replace(/\b(ok|pass|passed)$/, '<span style="color:var(--ok)">$1</span>')
    .replace(/\b(FAIL|FAILED|failed)\b/, '<span style="color:var(--fail)">$1</span>')

const kindTag = (s: Step): string => (s.kind ? `<span class="muted" style="font-size:11px;margin-left:8px">${esc(s.kind)}</span>` : '')

function stepDetail(run: Run, step: Step, withTitle: boolean): string {
  const tabs: [Tab, string][] = [
    ['logs', 'Logs'],
    ['outputs', 'Outputs'],
    ['data', 'Data']
  ]
  let body: string
  if (state.tab === 'outputs') {
    body = step.outputs === undefined ? '<span>No outputs.</span>' : esc(JSON.stringify(step.outputs, null, 2))
  } else if (state.tab === 'data') {
    body = step.data.length
      ? step.data
          .map((d) => `${esc(d.name)} <span style="color:var(--muted)">v${d.version}${d.type ? ` · ${esc(d.type)}` : ''} · ${esc(d.id.slice(0, 8))}</span>`)
          .join('\n')
      : '<span>No data written.</span>'
  } else {
    const error = step.status === 'failed' ? `<span style="color:var(--fail)">${esc(step.error)}</span>\n` : ''
    if (!step.logTag) body = error + (error ? '' : 'This step writes no log lines.')
    else if (state.logs.error) body = error + `<span style="color:var(--fail)">${esc(state.logs.error)}</span>`
    else if (!state.logs.value) body = error + 'Loading the log…'
    else {
      const lines = state.logs.value.text ? state.logs.value.text.split('\n').map(logLine) : []
      body =
        error +
        (state.logs.value.truncated ? '<span style="color:var(--muted)">… older lines cut</span>\n' : '') +
        (lines.length
          ? lines
              .map((l) => (l.level === 'error' ? `<span style="color:var(--fail)">${esc(l.text)}</span>` : l.level === 'warn' ? `<span style="color:var(--warm)">${esc(l.text)}</span>` : verdicts(esc(l.text))))
              .join('\n')
          : 'No log lines yet.')
    }
  }
  return `<section class="detail">
    ${withTitle ? `<div class="detail-head"><span style="font-weight:600">${esc(step.name)}</span><span class="muted" style="font-size:12px">· ${state.tab}</span></div>` : ''}
    ${step.description ? `<div class="step-about">${esc(step.description)}</div>` : ''}
    <div role="tablist" class="tabs">
      ${tabs.map(([id, label]) => `<button role="tab" aria-selected="${state.tab === id}" class="tab" data-action="tab" data-tab="${id}">${label}</button>`).join('')}
    </div>
    <pre class="log" data-keep-scroll="log">${body}</pre>
  </section>`
}

/** "Retry from here" on a step the failed run can start again from: always on a failed step, and on one that passed on hover, on focus and once pressed. */
function fromButton(run: Run, s: Step, job: string | undefined): string {
  if (job === undefined) return ''
  const id = `from:${job}/${s.name}`
  return `<button class="btn-outline from${s.status === 'failed' || state.acted === id ? '' : ' quiet'}" data-action="runAct" data-run-action="retry" data-job="${esc(job)}" data-step="${esc(s.name)}" title="${esc(actionCommand('retry', run, s.name))}" ${off()}>${controlText(id, 'Retry from here', 'Starting…')}</button>${controlError(id)}`
}

function timeline(run: Run, steps: Step[]): string {
  const now = Date.now()
  const from = retryFrom(run)
  return `<ol class="timeline">
    ${steps
      .map((s, i) => {
        const open = state.selected === s.name
        const lineColor = s.status === 'succeeded' ? 'var(--ok)' : 'var(--border-strong)'
        return `<li style="display:flex;gap:12px">
          <div style="display:flex;flex-direction:column;align-items:center;width:18px">
            ${icon(s)}
            ${i < steps.length - 1 ? `<div style="flex:1;min-height:14px;width:2px;margin:3px 0;background:${lineColor}"></div>` : ''}
          </div>
          <div style="flex:1;min-width:0;padding-bottom:10px;display:flex;flex-direction:column;gap:6px">
            <div class="with-from"><button class="step-row" data-action="select" data-step="${esc(s.name)}" aria-expanded="${open}">
              <span class="step-text">
                <span><span class="mono" style="font-size:12.5px;color:${s.status === 'pending' || s.status === 'skipped' ? 'var(--muted)' : 'var(--text)'}">${esc(s.name)}</span>${kindTag(s)}</span>
                ${s.description && !open ? `<span class="muted ellipsis" style="font-size:12px">${esc(s.description)}</span>` : ''}
              </span>
              <span class="muted" style="font-size:12px;white-space:nowrap">${esc(stepTime(s, now))}</span>
            </button>${fromButton(run, s, from.get(s))}</div>
            ${open ? stepDetail(run, s, false) : ''}
          </div>
        </li>`
      })
      .join('')}
  </ol>`
}

function stepCard(s: Step, wide: boolean, now: number, retry: string): string {
  const card = stepNode(s, wide, now)
  return retry ? `<div class="with-from${wide ? '' : ' col'}">${card}${retry}</div>` : card
}

function stepNode(s: Step, wide: boolean, now: number): string {
  const tone = stepTone(s)
  const border =
    tone === 'fail' ? 'border-color:var(--fail);background:var(--fail-bg)' : tone === 'wait' ? 'border-color:var(--gold);background:var(--gold-bg)' : tone === 'run' ? 'border-color:var(--run)' : ''
  const quiet = s.status === 'pending' || s.status === 'skipped'
  const style = `${quiet ? 'border-style:dashed;background:none;color:var(--muted)' : ''};${border}${state.selected === s.name ? ';box-shadow:0 0 0 1px var(--ring)' : ''}`
  const time = stepTime(s, now)
  if (wide) {
    return `<button class="node" style="${style}" data-action="select" data-step="${esc(s.name)}">
      ${icon(s, 16)}<span class="step-text">
        <span><span class="mono" style="font-size:12.5px">${esc(s.name)}</span>${kindTag(s)}</span>
        ${s.description ? `<span class="muted ellipsis" style="font-size:12px">${esc(s.description)}</span>` : ''}
      </span>
      <span style="margin-left:auto;font-size:12px;color:var(--muted);white-space:nowrap">${esc(time)}</span>
    </button>`
  }
  // Two cards share the row, so the description waits for the selected step's detail.
  const caption = [s.status === 'failed' ? s.error.split('\n')[0] : '', s.status === 'waiting' ? `waiting ${time}` : time, s.kind].filter(Boolean).join(' · ')
  return `<button class="node node-col" style="${style}" data-action="select" data-step="${esc(s.name)}">
    <span style="display:flex;align-items:center;gap:8px">${icon(s, 16)}<span class="mono" style="font-size:12.5px">${esc(s.name)}</span></span>
    <span class="ellipsis" style="font-size:12px;color:var(--muted)">${esc(caption || ' ')}</span>
  </button>`
}

function connector(kind: 'fork' | 'join' | 'line', columns: number, solid: boolean): string {
  const stroke = solid ? 'var(--ok)' : 'var(--border-strong)'
  const dash = solid ? '' : 'stroke-dasharray="4 3"'
  const xs = Array.from({ length: columns }, (_, i) => ((i + 0.5) / columns) * 100)
  const d =
    kind === 'line'
      ? 'M50 0v20'
      : kind === 'fork'
        ? `M50 0v8M${xs[0]} 8H${xs.at(-1)}${xs.map((x) => `M${x} 8v18`).join('')}`
        : `${xs.map((x) => `M${x} 0v18`).join('')}M${xs[0]} 18H${xs.at(-1)}M50 18v8`
  const h = kind === 'line' ? 20 : 26
  return `<svg width="100%" height="${h}" viewBox="0 0 100 ${h}" preserveAspectRatio="none" aria-hidden="true" style="display:block"><path d="${d}" fill="none" stroke="${stroke}" stroke-width="2" vector-effect="non-scaling-stroke" ${dash}/></svg>`
}

const started = (s: Step) => s.status !== 'pending' && s.status !== 'skipped'

function graph(run: Run): string {
  const now = Date.now()
  const from = retryFrom(run)
  const card = (s: Step, wide: boolean) => stepCard(s, wide, now, fromButton(run, s, from.get(s)))
  const out: string[] = []
  run.jobs.forEach((job, j) => {
    if (run.jobs.length > 1) out.push(`<div class="label" style="margin:${j ? 12 : 0}px 0 6px">${esc(job.name.toUpperCase())}${job.description ? `<span style="font-weight:400"> · ${esc(job.description)}</span>` : ''}</div>`)
    job.stages.forEach((stage, i) => {
      const next = job.stages[i + 1]
      if (stage.length === 1) out.push(card(stage[0], true))
      else {
        const cols = Math.min(stage.length, 2)
        out.push(`<div class="parallel" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${stage.map((s) => card(s, false)).join('')}</div>`)
      }
      if (!next) return
      const solid = next.some(started)
      if (next.length > 1) {
        out.push(connector('fork', Math.min(next.length, 2), solid))
        out.push('<div class="label" style="margin:-2px 0 4px;font-size:11px;letter-spacing:0.04em;font-weight:400;text-align:center">PARALLEL</div>')
      } else if (stage.length > 1) out.push(connector('join', Math.min(stage.length, 2), solid))
      else out.push(connector('line', 1, solid))
    })
  })
  const selected = stepsOf(run).find((s) => s.name === state.selected)
  return `<div style="display:flex;flex-direction:column">${out.join('')}</div>${selected ? stepDetail(run, selected, true) : ''}`
}

function gateCard(run: Run, step: Extract<Step, { status: 'waiting' }>): string {
  const now = Date.now()
  const busy = state.busy ? 'disabled' : ''
  return `<div class="gate">
    <div style="display:flex;align-items:center;gap:8px">${diamond(12)}<span style="font-weight:600">${esc(step.name)} · ${step.expired ? 'expired' : `waiting ${since(step.since, now)}`}</span></div>
    ${step.prompt ? `<div class="muted" style="line-height:1.5">${esc(step.prompt)}</div>` : ''}
    ${
      step.expired
        ? '<div class="muted" style="font-size:12px">This gate timed out. Swamp can only cancel it now.</div>'
        : `<label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)">Note (optional)
      <textarea id="note-${esc(step.name)}" rows="2" class="note" data-input="note" data-step="${esc(step.name)}" ${busy}>${esc(state.notes[step.name] ?? '')}</textarea>
    </label>
    <div style="display:flex;gap:8px">
      <button class="btn-gold" style="flex:1;min-height:38px" data-action="decide" data-decision="approve" data-step="${esc(step.name)}" ${busy}>${state.busy ? 'Working…' : 'Approve'}</button>
      <button class="btn-outline" style="flex:1;min-height:38px" data-action="decide" data-decision="reject" data-step="${esc(step.name)}" ${busy}>Reject</button>
    </div>
    ${state.actionError && !state.acted ? `<div style="color:var(--fail);font-size:12px">${esc(state.actionError)}</div>` : ''}
    <div class="mono muted" style="font-size:11.5px;overflow-wrap:anywhere">runs: ${esc(approveCommand(run.workflow, step.name, run.id))}</div>`
    }
  </div>`
}

function failureActions(run: Run, step: Extract<Step, { status: 'failed' }>): string {
  const repo = repoDir()
  // Send types into a terminal of the focused workspace, which works in another repo than a visited one.
  const off = state.visiting ? 'Send types into a terminal of the focused workspace, and this run is in another repo. Copy the retry command and run it there.' : repo && remoteOff(repo, 'send')
  const agent = off ? null : state.agent
  const flash = (action: string, text: string) => (state.flash?.action === action ? esc(state.flash.text) : text)
  return `<div style="display:flex;flex-direction:column;gap:8px">
    <button class="btn-accent" data-action="send" ${agent ? '' : 'disabled'}${off ? ` title="${esc(off)}"` : ''}>${flash('send', 'Send failure to agent terminal')}</button>
    <button class="btn-outline" style="min-height:36px" data-action="copy">${flash('copy', 'Copy retry command')}</button>
    ${state.actionError && !state.acted ? `<div style="color:var(--fail);font-size:12px">${esc(state.actionError)}</div>` : ''}
    <div class="muted" style="font-size:11.5px;line-height:1.5">${
      off
        ? esc(off)
        : agent
        ? `Send types the failure into <b style="color:var(--text);font-weight:500">${esc(agent.title)}</b> in ${esc(agent.workspace)}, without pressing Enter.`
        : 'Open a terminal in this workspace to send the failure to an agent.'
    } The retry command is <span class="mono" style="overflow-wrap:anywhere">${esc(retryCommand(run, step.name))}</span>.</div>
  </div>`
}

/**
 * The run's controls: what its status offers, then Run for a new run of the workflow. An action that needs it shows
 * its question and its swamp command in place of the buttons until a second press or a way out.
 */
function runBar(run: Run): string {
  const actions = runActions(run)
  const button = (action: RunAction, cls: string) =>
    `<button class="${cls} ctl" data-action="runAct" data-run-action="${action}" ${action === 'again' ? 'title="Start a new run with this run’s inputs"' : ''} ${off()}>${controlText(action, actionLabel(action, run.status), ACTION_LOOK[action].busy)}</button>`
  const asked = state.confirm && state.confirm !== 'again' && actions.includes(state.confirm) ? state.confirm : undefined
  const row = asked
    ? `<div class="ask" role="alert">
        <span>${esc(ACTION_LOOK[asked].confirm)}</span>
        <div class="ctls">${button(asked, 'btn-danger')}<button class="btn-outline ctl" data-action="unconfirm" ${off()}>${asked === 'stop' ? 'Keep running' : 'Cancel'}</button></div>
        <span class="mono muted" style="font-size:11.5px">runs: ${esc(actionCommand(asked, run))}</span>
      </div>`
    : `<div class="ctls">${actions.map((a) => button(a, 'btn-outline')).join('')}${runButton(run.workflow)}</div>`
  return row + runForm(run.workflow) + [...actions, `run:${run.workflow}`].map(controlError).join('')
}

/** Where `render` puts the live log's element. */
const LOG_SLOT = '<div id="log-slot"></div>'

function runScreen(run: Run): string {
  const now = Date.now()
  const p = runPill(run)
  const steps = stepsOf(run)
  const parallel = run.jobs.some((j) => j.stages.some((s) => s.length > 1))
  const gates = steps.filter((s): s is Extract<Step, { status: 'waiting' }> => s.status === 'waiting')
  const failed = run.status === 'failed' ? firstFailed(run) : undefined
  const meta = [`run ${shortId(run.id)}`, ago(run.startedAt, now), run.status !== 'running' ? duration(run.durationMs) : '']
    .filter(Boolean)
    .join(' · ')
  const usual = usualTimes(state.list.data?.runs ?? []).get(run.workflow)
  // While the run moves, what it is doing now comes before its steps; once it ended, its steps and its failure do.
  const following = inFlight(run.status)
  // A line the run logged is activity too, and for a remote repo the only sign of it between two steps.
  const logged = tail.key === tailKey(run) ? tail.lines.at(-1)?.at : undefined
  const pace = paceOf(withVitals(run, logged ? { activeAt: logged } : {}), usual, now)
  const look = pace && PACE_LOOK[pace.state]
  const paceLine = pace
    ? `<div role="status" style="display:flex;flex-direction:column;gap:3px;font-size:12px;line-height:1.45">
        <div><span class="muted">${esc(paceProgress(pace))}</span>${look!.label ? `<span style="color:${TONE_VAR[look!.tone]};font-weight:600"> · ${esc(paceLabel(pace))}</span>` : ''}</div>
        ${look!.hint ? `<div class="muted">${esc(look!.hint)}</div>` : ''}
      </div>`
    : !inFlight(run.status) && usual !== undefined
      ? `<div class="muted" style="font-size:12px">usually ${brief(usual)}</div>`
      : ''
  return `<div class="body" style="gap:12px;flex:1">
    <div style="display:flex;align-items:center;gap:8px">
      <button class="back" data-action="back" aria-label="Back">‹</button>
      <span class="mono" style="font-weight:600">${esc(run.workflow)}</span>
      <span style="margin-left:auto">${pill(p.tone, p.text)}</span>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:6px">
      ${Object.entries(run.inputs)
        .map(([k, v]) => `<span class="chip">${esc(k)} <span style="color:var(--text)">${esc(v)}</span></span>`)
        .join('')}
      <span class="muted" style="font-size:11.5px;padding:3px ${Object.keys(run.inputs).length ? 8 : 0}px">${esc(meta)}</span>
    </div>
    ${paceLine}
    ${runBar(run)}
    ${following ? LOG_SLOT : ''}
    ${parallel ? graph(run) : timeline(run, steps)}
    ${gates.length ? `<div style="margin-top:auto;display:flex;flex-direction:column;gap:12px">${gates.map((g) => gateCard(run, g)).join('')}</div>` : ''}
    ${failed ? failureActions(run, failed) : ''}
    ${following ? '' : LOG_SLOT}
    ${runsOf(run)}
  </div>`
}

/** The run's workflow's latest runs, from the list the Workflows tab already read. */
function runsOf(run: Run): string {
  const runs = state.list.data?.workflows.find((w) => w.name === run.workflow)?.runs ?? []
  if (runs.length < 2) return ''
  const now = Date.now()
  const usual = usualTimes(state.list.data?.runs ?? []).get(run.workflow)
  return `<section class="section" style="gap:2px;margin-top:6px">
    <div class="label" style="margin-bottom:6px">RECENT RUNS</div>
    ${runs.map((r) => runRow(r, shortId(r.runId), now, usual, run.id)).join('')}
  </section>`
}

function sectionTabs(): string {
  const f = state.factories.data
  const waiting = f?.installed ? f.factories.reduce((n, x) => n + x.needYou, 0) : 0
  const tab = (id: Place['tab'], label: string) => `<button role="tab" class="seg" aria-selected="${state.place.tab === id}" ${goTo(home(id))}>${label}</button>`
  const mine = state.inbox.data?.items.length ?? 0
  return `<div role="tablist" class="segs">
    ${state.inboxOn ? tab('inbox', `Needs you${mine ? ` <span style="color:var(--gold)">· ${mine}</span>` : ''}`) : ''}
    ${tab('workflows', 'Workflows')}
    ${tab('stagecraft', `StageCraft${waiting ? ` <span style="color:var(--gold)">· ${waiting}</span>` : ''}`)}
  </div>`
}

const copyRow = (text: string, id: string) => `<div class="copy-row">
  <code class="mono">${esc(text)}</code>
  <button class="btn-outline" style="min-height:30px;padding:0 10px;flex-shrink:0" data-action="copyText" data-flash="${id}" data-text="${esc(text)}">${state.flash?.action === id ? esc(state.flash.text) : 'Copy'}</button>
</div>`

function notInstalled(): string {
  return `<div class="body">
    <section class="card" style="display:flex;flex-direction:column;gap:10px">
      <div style="font-weight:600">StageCraft is not installed in this repo</div>
      <div class="muted" style="line-height:1.5">StageCraft is a swamp extension that builds <b style="color:var(--text);font-weight:500">factories</b>: your process as stages, with gates that decide when a work item moves on, and stops where a person must decide. This tab shows each factory's board and lets you approve or decline those stops.</div>
      <div class="label">INSTALL IT IN THIS REPO</div>
      ${copyRow(INSTALL_COMMAND, 'install')}
      <div class="muted" style="font-size:12px;line-height:1.5">Then ask your agent to "set up a stagecraft factory". It writes the factory and drives the first work item.</div>
      <div><button class="btn-outline" data-action="refresh" style="min-height:32px;padding:0 12px">Check again</button></div>
    </section>
  </div>`
}

function noFactories(): string {
  return `<div class="body"><section class="card" style="display:flex;flex-direction:column;gap:8px">
    <div style="font-weight:600">No factories yet</div>
    <div class="muted" style="line-height:1.5">StageCraft is installed, but this repo has no factory. Ask your agent to "set up a stagecraft factory for &lt;your process&gt;". It writes <span class="mono" style="overflow-wrap:anywhere">models/@swamp/stagecraft/factory/&lt;name&gt;.yaml</span>.</div>
    <div><button class="btn-outline" data-action="refresh" style="min-height:32px;padding:0 12px">Check again</button></div>
  </section></div>`
}

const TICKET_COLOR: Record<TicketStatus, string> = {
  'needs-you': 'var(--gold)',
  stuck: 'var(--warm)',
  working: 'var(--run)',
  queued: 'var(--muted)',
  done: 'var(--ok)',
  abandoned: 'var(--dim)'
}

const ACTIVE: TicketStatus[] = ['needs-you', 'stuck', 'working', 'queued']

function studioButton(): string {
  const repo = repoDir()
  const off = repo && remoteOff(repo, 'studio')
  return `<button class="btn-outline studio" data-action="studio" ${off ? `disabled title="${esc(off)}"` : ''}>${state.studio.url ? 'Open studio' : 'Studio'} ${EXTERNAL}</button>`
}

function studioNotes(): string {
  const repo = repoDir()
  const off = repo && remoteOff(repo, 'studio')
  return `${off ? `<div class="muted" style="font-size:11.5px;line-height:1.5">${esc(off)}</div>` : ''}
  ${state.studio.error ? `<div style="color:var(--fail);font-size:12px">${esc(state.studio.error)}</div>` : ''}`
}

const needYou = (n: number) => `${n} need${n === 1 ? 's' : ''} you`

function factoryList(factories: FactorySummary[]): string {
  const shown = factories.filter((f) => matches(f.name))
  return `<div class="body" style="gap:18px">
    <label><span class="sr">Search factories</span>
      <input id="search" type="search" class="input" placeholder="Search factories" value="${esc(state.search)}" data-input="search">
    </label>
    <section class="section">
      <div class="label">FACTORIES · ${shown.length}</div>
      ${
        shown.length === 0
          ? '<div class="muted">No factory matches.</div>'
          : shown
              .map((f) => {
                const bars = [...Array(Math.max(0, HISTORY_LENGTH - f.tickets.length)).fill(null), ...f.tickets] as (TicketStatus | null)[]
                const count = (s: TicketStatus) => f.tickets.filter((t) => t === s).length
                const active = f.tickets.length - count('done') - count('abandoned')
                return `<button class="card wf" ${goTo({ tab: 'stagecraft', factory: f.name })}>
                  <div style="display:flex;align-items:center;gap:8px">
                    <span class="mono" style="font-weight:600">${esc(f.name)}</span>
                    <span style="margin-left:auto">${f.needYou ? pill('wait', needYou(f.needYou), 11.5) : ''}</span>
                  </div>
                  <div style="display:flex;gap:3px" role="img" aria-label="Latest ${f.tickets.length} tickets: ${count('done')} done, ${active} in progress, ${count('abandoned')} abandoned">
                    ${bars.map((t) => `<span class="bar" style="background:${t ? TICKET_COLOR[t] : 'var(--dim-fill)'}"></span>`).join('')}
                  </div>
                </button>`
              })
              .join('')
      }
    </section>
  </div>`
}

/** The mark in a grid cell; `after` is true for a stage past the one the ticket is in now. */
function cellMark(c: Cell, status: TicketStatus, stage: string, after: boolean): string {
  const times = c.passes ? `, ${c.passes} times` : ''
  const mark = (cls: string, label: string, style = '') => `<span class="mk ${cls}" role="img" aria-label="${esc(label)}" title="${esc(label)}" style="${style}"></span>`
  const text = (t: string, color: string, label: string) => `<span class="mk-text" style="color:${color}" title="${esc(label)}">${t}</span>`
  switch (c.kind) {
    case 'now':
      return mark(`mk-now ${status}`, `${stage}: ${TICKET_LABEL[status]} now${times}`, `--c:${TICKET_COLOR[status]}`)
    case 'back':
      return text('back', 'var(--warm)', `${stage}: sent back from here${times}`)
    case 'passed':
      return c.passes || after ? text(`${c.passes ?? 1}×`, 'var(--ok)', `${stage}: passed${times}`) : mark('mk-pass', `${stage}: passed`)
    case 'ahead':
      return mark('mk-ahead', `${stage}: not reached`)
  }
}

/** `single` is the one-row grid on a ticket's own screen: no title, and nothing in it opens the ticket again. */
function ticketGrid(columns: Stage[], items: WorkItem[], now: number, single = false): string {
  const rows = items.map((w) => {
    const col = columns.findIndex((s) => s.id === w.stage)
    const cells = cellsOf(columns, w)
    return { w, col, cells }
  })
  const place = (w: WorkItem): Place => ({ tab: 'stagecraft', factory: w.factory, item: w.key })
  const line = (w: WorkItem, col: number) => `<button class="tline" data-action="seeStage" data-col="${col}" ${single ? '' : placeAttr(place(w))} style="color:${TICKET_COLOR[w.status]}" title="${esc(whyHere(w, now).text)}">
      <span class="tlabel">${esc(reasonWord(w))} · </span><span class="when ellipsis">${esc(ticketWhen(w, now))}</span><span class="where ellipsis">${esc(w.stage)}</span><span class="off" aria-hidden="true">›</span>
    </button>`
  return `<div class="pager" hidden>
      <span class="pager-text" style="flex:1"></span>
      <button class="icon-btn" data-action="pageStages" data-dir="-1" aria-label="Earlier stages">‹</button>
      <button class="icon-btn" data-action="pageStages" data-dir="1" aria-label="Later stages">›</button>
    </div>
    <div class="grid" data-grid data-cols="${columns.length}"${single ? ` data-now-col="${rows[0].col}"` : ''}>
      <div class="grid-names"${single ? ' style="flex-basis:96px"' : ''}>
        <div class="grid-head label">${single ? 'STAGES' : 'IN PROGRESS'}</div>
        ${rows
          .map(
            ({ w, col }) => `<div class="grid-row name-cell">
          ${single ? '' : `<button class="tname ellipsis" ${goTo(place(w))} title="${esc(`${w.key} · ${w.title}`)}">${esc(w.title)}</button>`}
          ${line(w, col)}
        </div>`
          )
          .join('')}
      </div>
      <div class="grid-scroll" data-keep-scroll="${single ? 'ticket-stages' : 'stages'}">
        <div class="grid-cols" style="grid-template-columns:repeat(${columns.length}, minmax(44px, 1fr))">
          ${columns.map((s) => `<span class="grid-head stage ellipsis${s.workflow ? ' runs' : ''}" title="${esc(s.workflow ? `${s.id} · runs ${s.workflow}` : s.id)}">${esc(s.id)}</span>`).join('')}
          ${rows.map(({ w, col, cells }) => cells.map((c, i) => {
                const mark = cellMark(c, w.status, columns[i].id, col >= 0 && i > col)
                return single ? `<span class="grid-row cell">${mark}</span>` : `<button class="grid-row cell" ${goTo(place(w))} tabindex="-1">${mark}</button>`
              }).join('')).join('')}
        </div>
      </div>
      <div class="grid-fade" aria-hidden="true"></div>
    </div>`
}

const LEGEND = `<div class="legend">
  <span><span class="mk mk-pass"></span>passed</span>
  <span><span class="mk mk-now working" style="--c:var(--run)"></span>working</span>
  <span><span class="mk mk-now needs-you" style="--c:var(--gold)"></span>needs you</span>
  <span><span class="mk mk-now stuck" style="--c:var(--warm)"></span>stuck</span>
  <span><span class="mk mk-now queued" style="--c:var(--muted)"></span>queued</span>
  <span><span class="mk-text" style="color:var(--warm)">back</span>sent back</span>
</div>`

/** What each stage is for, in the factory author's words: the grid's column heads have room for the id only. */
function stageList(stages: Stage[]): string {
  const told = stages.filter((s) => s.description)
  if (!told.length) return ''
  return `<section class="section" style="gap:6px;border-top:1px solid var(--border);padding-top:12px">
    <div class="label">STAGES</div>
    ${told
      .map((s) => {
        const how = s.workflow ? `runs ${s.workflow}` : s.terminal ? 'end' : s.mode
        return `<div style="display:flex;flex-direction:column;gap:2px">
        <div><span class="mono" style="font-size:12.5px">${esc(s.id)}</span>${how ? `<span class="muted" style="font-size:11px;margin-left:8px">${esc(how)}</span>` : ''}</div>
        <div class="muted clamp clamp2" style="font-size:12px;line-height:1.45" title="${esc(s.description!)}">${esc(s.description!)}</div>
      </div>`
      })
      .join('')}
  </section>`
}

function factoryScreen(board: Board): string {
  const now = Date.now()
  const active = board.items.filter((i) => !isFinished(i.status))
  const shown = active.filter((i) => state.filter === 'all' || i.status === state.filter)
  const columns = board.stages.filter((s) => !s.terminal)
  const finished = board.items
    .filter((i) => isFinished(i.status))
    .sort((a, b) => (b.enteredAt ?? '').localeCompare(a.enteredAt ?? ''))
    .slice(0, RECENT_LENGTH)
  const chip = (id: TicketFilter, label: string, n: number) =>
    `<button class="fchip" aria-pressed="${state.filter === id}" style="--c:${id === 'all' ? 'var(--accent)' : TICKET_COLOR[id]}" data-action="filter" data-filter="${id}">${label} · ${n}</button>`
  return `<div class="body" style="gap:12px">
    <div style="display:flex;align-items:center;gap:8px">
      <button class="back" data-action="back" aria-label="Back to factories">‹</button>
      <span class="mono ellipsis" style="font-weight:600;flex:1">${esc(board.factory)}</span>
      ${studioButton()}
    </div>
    ${studioNotes()}
    ${
      board.items.length === 0
        ? `<div class="card" style="display:flex;flex-direction:column;gap:8px"><div style="font-weight:600">No work items in ${esc(board.factory)} yet</div>
            <div class="muted" style="font-size:12px;line-height:1.5">Ask your agent to start one, or run:</div>${copyRow(startCommand(board.factory), 'start')}</div>`
        : `<div style="display:flex;gap:6px;flex-wrap:wrap">
            ${chip('all', 'All', active.length)}
            ${ACTIVE.map((s) => chip(s, TICKET_LABEL[s].replace(/^./, (c) => c.toUpperCase()), active.filter((i) => i.status === s).length)).join('')}
          </div>
          ${shown.length ? ticketGrid(columns, shown, now) + LEGEND : `<div class="muted">${active.length ? 'No ticket matches this filter.' : 'Nothing in progress.'}</div>`}`
    }
    ${stageList(board.stages)}
    ${
      finished.length
        ? `<section class="section" style="gap:2px;border-top:1px solid var(--border);padding-top:12px">
        <div class="label" style="margin-bottom:6px">RECENT RUNS</div>
        ${finished
          .map((w) =>
            recentRow({
              place: { tab: 'stagecraft', factory: w.factory, item: w.key },
              color: TICKET_COLOR[w.status],
              name: w.key,
              detail: w.title,
              status: `${TICKET_LABEL[w.status]} · ${since(w.enteredAt, now)}`
            })
          )
          .join('')}
      </section>`
        : ''
    }
  </div>`
}

/** Scroll the stage columns so column `col` sits in the middle. */
function showStage(col: number, behavior: ScrollBehavior): void {
  const grid = root.querySelector<HTMLElement>('[data-grid]')
  const scroll = grid?.querySelector<HTMLElement>('.grid-scroll')
  if (!grid || !scroll || col < 0) return
  const width = scroll.scrollWidth / Number(grid.dataset.cols)
  scroll.scrollTo({ left: col * width - (scroll.clientWidth - width) / 2, behavior })
}

/** Shows the stage pager, the edge fade and each off-screen "›" once the stage columns no longer fit. */
function syncGrid(): void {
  const grid = root.querySelector<HTMLElement>('[data-grid]')
  const pager = root.querySelector<HTMLElement>('.pager')
  if (!grid || !pager) return
  const scroll = grid.querySelector<HTMLElement>('.grid-scroll')!
  const cols = Number(grid.dataset.cols)
  const wide = scroll.scrollWidth > scroll.clientWidth + 1
  grid.classList.toggle('wide', wide)
  pager.hidden = !wide
  if (!wide) return
  const width = scroll.scrollWidth / cols
  const first = Math.round(scroll.scrollLeft / width)
  const last = Math.min(cols, Math.floor((scroll.scrollLeft + scroll.clientWidth + 2) / width))
  pager.querySelector('.pager-text')!.textContent = `Stages ${first + 1} to ${last} of ${cols}`
  const [earlier, later] = Array.from(pager.querySelectorAll<HTMLButtonElement>('button'))
  earlier.disabled = first === 0
  later.disabled = last >= cols
  grid.classList.toggle('at-end', last >= cols)
  for (const line of Array.from(grid.querySelectorAll<HTMLElement>('.tline'))) {
    const col = Number(line.dataset.col)
    line.classList.toggle('offscreen', col >= 0 && (col < first || col >= last))
  }
}

const productKey = (p: Product): string => `${p.kind}:${p.name}`

function payloadBlock(b: PayloadBlock): string {
  const head = `<div class="label">${esc(b.label)}</div>`
  switch (b.kind) {
    case 'text':
      return `${head}<div style="line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere">${esc(b.text)}</div>`
    case 'list':
      return `${head}<ul class="payload-list">${b.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
    case 'steps':
      return `${head}<ol class="payload-list">${b.steps
        .map(
          (s) => `<li><div style="line-height:1.5">${esc(s.description)}</div>${
            s.files.length ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">${s.files.map((f) => `<span class="chip mono">${esc(f)}</span>`).join('')}</div>` : ''
          }</li>`
        )
        .join('')}</ol>`
    case 'findings':
      return `${head}${b.findings
        .map(
          (f) => `<div style="display:flex;gap:8px;align-items:baseline;${f.resolved ? 'color:var(--muted)' : ''}">${pill(f.resolved ? 'muted' : f.tone, f.severity, 11)}<span style="line-height:1.5;flex:1;min-width:0;overflow-wrap:anywhere">${esc(f.description)}${f.resolved ? ' · resolved' : ''}</span></div>`
        )
        .join('')}`
    case 'fields':
      return `${head}<div class="payload-fields">${b.rows.map(([k, v]) => `<span class="mono muted">${esc(k)}</span><span>${esc(v)}</span>`).join('')}</div>`
  }
}

function productRow(p: Product, now: number): string {
  const key = productKey(p)
  const open = state.productOpen[key] ?? p.forGate
  const note = storedNote(p)
  const body =
    p.stored.match === 'missing' ? '' : `<div class="payload" data-keep-scroll="${esc(key)}">${payloadBlocks(p.stored.payload).map((b) => `<div class="section" style="gap:4px">${payloadBlock(b)}</div>`).join('')}</div>`
  return `<button class="product" data-action="product" data-product="${esc(key)}" aria-expanded="${open}">
      <span style="white-space:nowrap"><span class="muted" aria-hidden="true">${open ? '▾' : '▸'}</span> ${esc(p.name)}</span>
      <span style="font-size:12px;text-align:right;color:${note ? 'var(--gold)' : 'var(--muted)'}">${note ? '◆ ' : ''}${esc(p.summary)} · ${esc(ago(p.at, now))}</span>
    </button>
    ${open ? `<div class="detail">${note ? `<div class="stale" style="margin:8px 8px 0">${esc(note)}</div>` : ''}${body}</div>` : ''}`
}

function itemScreen(d: Decided): string {
  const now = Date.now()
  const { item } = d
  const busy = state.busy ? 'disabled' : ''
  const held = new Map((item.waiting?.exits ?? []).map((x) => [x.transition, x]))
  const stage = d.stages.find((s) => s.id === item.stage)
  const runs = stage?.workflow
  const pending = [...held.values()].flatMap((x) => x.gateIds.map((g) => ({ gate: g, exit: x })))
  const why = whyHere(item, now)
  const sent = 'dispatch' in item.reason && item.reason.dispatch.workflow ? item.reason.dispatch : undefined
  const sentRun = sent && dispatchRun(state.list.data?.runs ?? [], sent)
  const held_ = since(item.reason.since, now)
  const whyBlock = `<section class="card" style="display:flex;flex-direction:column;gap:6px;border-left:3px solid ${TICKET_COLOR[item.status]}">
      <div class="label">WHY IT IS HERE</div>
      <div style="font-weight:600;line-height:1.4;color:${item.status === 'queued' ? 'var(--text)' : TICKET_COLOR[item.status]}">${esc(why.text)}</div>
      ${why.why ? `<div class="mono muted clamp" style="font-size:11.5px;line-height:1.45;overflow-wrap:anywhere" title="${esc(why.why)}">${esc(why.why)}</div>` : ''}
      ${held_ || why.next ? `<div class="muted" style="font-size:12px;line-height:1.5">${esc([held_ && `For ${held_}.`, why.next].filter(Boolean).join(' '))}</div>` : ''}
      ${
        sent
          ? `<div><button class="btn-outline" style="min-height:30px;padding:0 12px" ${goTo({ tab: 'workflows', workflow: sent.workflow!, ...(sentRun && { runId: sentRun.runId }) })}>${
              sentRun ? `Open the run${sentRun.failedStep ? ` · failed at ${esc(sentRun.failedStep)}` : ''}` : `Open ${esc(sent.workflow!)}`
            }</button></div>`
          : item.reason.kind === 'gate' && state.itemTab !== 'now'
            ? `<div><button class="btn-outline" style="min-height:30px;padding:0 12px" data-action="itemTab" data-tab="now">Decide</button></div>`
            : ''
      }
    </section>`
  const tab = (id: ItemTab, label: string) =>
    `<button role="tab" aria-selected="${state.itemTab === id}" class="tab" style="font-size:13px;padding:8px 12px" data-action="itemTab" data-tab="${id}">${label}</button>`
  const products = d.products.length
    ? `<section class="section" style="gap:6px"><div class="label">PRODUCTS</div>${d.products.map((p) => productRow(p, now)).join('')}</section>`
    : ''
  const now_ = `
    <div style="display:flex;flex-direction:column;gap:4px">
      <div class="muted" style="font-size:12px">In <span class="mono" style="color:var(--text)">${esc(item.stage)}</span>${runs ? ` · runs <span class="mono" style="color:var(--text)">${esc(runs)}</span>` : ''} · cycle ${item.cycle} · ${esc(since(item.enteredAt, now))}</div>
      ${stage?.description ? `<div class="muted" style="font-size:12px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere">${esc(stage.description)}</div>` : ''}
    </div>
    ${
      d.exits.length
        ? `<section class="section"><div class="label">EXITS</div>${d.exits
            .map((x) => {
              const h = held.get(x.name)
              return `<div class="exit" style="${h ? 'border-color:var(--gold);background:var(--gold-bg)' : ''}">
                <div style="display:flex;gap:8px;align-items:baseline"><span style="font-weight:600">${esc(x.name)}</span><span class="muted" style="font-size:12px">→ ${esc(x.to)}</span>
                <span style="margin-left:auto;font-size:11.5px;color:${h ? 'var(--gold)' : 'var(--muted)'}">${h ? 'needs a person' : x.manual ? 'manual' : ''}</span></div>
                ${
                  h
                    ? x.gates
                        .map((g) => {
                          const waits = g.person !== undefined && h.gateIds.includes(g.person)
                          return `<div style="display:flex;gap:8px;align-items:center;font-size:12px"><span style="width:14px;text-align:center;color:${waits ? 'var(--gold)' : 'var(--ok)'}" aria-label="${waits ? 'waiting' : 'passes'}">${waits ? '◆' : '✓'}</span><span class="mono muted">${esc(g.label)}</span></div>`
                        })
                        .join('')
                    : ''
                }
              </div>`
            })
            .join('')}</section>`
        : ''
    }
    ${pending.length ? products : ''}
    ${
      pending.length
        ? `<label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)">Note (optional, goes in the journal)
            <textarea id="note" rows="2" class="note" data-input="note" data-step="" ${busy}>${esc(state.notes[''] ?? '')}</textarea></label>
          ${pending
            .map(
              (p) => `<div style="display:flex;gap:8px">
            <button class="btn-gold" style="flex:1;min-height:38px" data-action="scDecide" data-decision="approve" data-gate="${esc(p.gate)}" ${busy}>${state.busy ? 'Working…' : esc(approveLabel(p.gate))}</button>
            <button class="btn-outline" style="flex:1;min-height:38px" data-action="scDecide" data-decision="decline" data-gate="${esc(p.gate)}" ${busy}>Decline</button>
          </div>`
            )
            .join('')}`
        : ''
    }
    ${d.advanced ? `<div style="color:var(--ok);font-size:12px">Approved and moved to ${esc(d.advanced)}.</div>` : ''}
    ${d.advanceError ? `<div style="color:var(--warm);font-size:12px">Approved, but it did not move on: ${esc(d.advanceError)}</div>` : ''}
    ${state.actionError ? `<div style="color:var(--fail);font-size:12px">${esc(state.actionError)}</div>` : ''}
    ${pending.length ? '' : products}
    <section style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px">
      ${[
        [duration(d.metrics.totalMs) || '—', 'total time'],
        [String(d.metrics.reviewRounds), 'review rounds'],
        [String(d.metrics.dispatches), 'dispatches']
      ]
        .map(([v, l]) => `<div class="metric"><div style="font-size:16px;font-weight:600">${esc(v)}</div><div class="muted" style="font-size:11.5px">${l}</div></div>`)
        .join('')}
    </section>
    ${
      pending.length
        ? `<div class="muted" style="margin-top:auto;font-size:11.5px;line-height:1.5">Approve runs the work item's <span class="mono">approve</span> method with ${esc(pending[0].gate)}, then advances it on <span class="mono">${esc(pending[0].exit.transition)}</span>. Decline runs <span class="mono">decline</span> and leaves it in ${esc(item.stage)}.</div>`
        : ''
    }`
  const timeline = `<ol class="journal">${d.timeline
    .map((e) => `<li><span class="muted mono" style="font-size:11px;white-space:nowrap">${esc(ago(e.at, now))}</span><span class="mono muted" style="font-size:11.5px">${esc(e.stage)}${e.cycle > 1 ? `·${e.cycle}` : ''}</span><span>${esc(e.text)}</span></li>`)
    .join('')}</ol>`
  return `<div class="body" style="gap:14px;flex:1">
    <div style="display:flex;align-items:center;gap:8px">
      <button class="back" data-action="back" aria-label="Back to factory">‹</button>
      <span class="mono muted">${esc(item.key)}</span>
      <span class="ellipsis" style="font-weight:600;flex:1">${esc(item.title)}</span>
    </div>
    ${whyBlock}
    <div class="section" style="gap:6px">${ticketGrid(d.stages, [item], now, true)}${LEGEND}</div>
    <div role="tablist" class="tabs">${tab('now', 'Now')}${tab('timeline', 'Timeline')}</div>
    ${state.itemTab === 'now' ? now_ : timeline}
  </div>`
}

function inboxRow(i: InboxItem, now: number): string {
  const id = inboxId(i)
  const busy = state.busy ? 'disabled' : ''
  const expired = i.kind === 'gate' && i.gate.expired
  const what = i.kind === 'gate' ? `${esc(i.gate.workflow)} › ${esc(i.gate.step)}` : `${esc(i.factory)} › ${esc(i.key)} · ${esc(i.stage)}`
  const about = i.kind === 'gate' ? [i.gate.prompt, i.gate.input ?? `run ${shortId(i.gate.runId)}`] : [i.title, i.gates.length ? `waiting on ${i.gates.join(', ')}` : 'waiting on a person']
  const decide = (decision: string, label: string, gate = '') =>
    `<button class="${decision === 'approve' ? 'btn-gold' : 'btn-outline'}" style="flex:1;min-height:34px" data-action="inboxDecide" data-item="${esc(id)}" data-decision="${decision}" data-gate="${esc(gate)}" ${busy}>${esc(label)}</button>`
  const buttons =
    i.kind === 'gate'
      ? [decide('approve', 'Approve') + decide('reject', 'Reject')]
      : i.gates.map((g) => decide('approve', approveLabel(g), g) + decide('decline', 'Decline', g))
  return `<div class="gate" style="padding:12px;gap:8px">
    <div style="display:flex;align-items:center;gap:8px">
      ${diamond(12)}<span style="font-weight:600;flex:1;min-width:0">${what}</span>
      <span class="muted" style="font-size:12px;white-space:nowrap">${expired ? 'expired' : esc(since(i.since, now))}</span>
      <button class="btn-outline" style="min-height:28px;padding:0 10px;flex-shrink:0" data-action="inboxOpen" data-item="${esc(id)}">Open</button>
    </div>
    ${about.filter(Boolean).map((t) => `<div class="muted clamp" style="font-size:12px;line-height:1.45">${esc(t)}</div>`).join('')}
    ${
      expired
        ? '<div class="muted" style="font-size:12px">This gate timed out. Swamp can only cancel it now.</div>'
        : buttons.length
          ? `<input class="note" style="font-size:12px" placeholder="Note (optional)" aria-label="Note for ${what}" id="note-${esc(id)}" data-input="note" data-step="${esc(id)}" value="${esc(state.notes[id] ?? '')}" ${busy}>
             ${buttons.map((b) => `<div style="display:flex;gap:8px">${b}</div>`).join('')}`
          : '<div class="muted" style="font-size:12px">Open it to see which exit a person must take.</div>'
    }
  </div>`
}

function inboxView(): string {
  const { data, error } = state.inbox
  if (!data) return `<div class="body${error ? '' : ' muted'}">${error ? errorBox(error) : 'Reading your repos…'}</div>`
  const now = Date.now()
  const read = data.repos - data.failed.length
  const repos = `Read ${data.failed.length ? `${read} of ${data.repos}` : read} repo${data.repos === 1 ? '' : 's'}.`
  return `${error ? `<div class="stale">Showing the last answer. ${esc(error.message)}</div>` : ''}
  <div class="body" style="gap:18px">
    ${state.actionError ? `<div style="color:var(--fail);font-size:12px">${esc(state.actionError)}</div>` : ''}
    ${
      data.items.length
        ? inboxGroups(data.items)
            .map((g) => `<section class="section"><div class="label">${esc(g.label.toUpperCase())} · ${g.items.length}</div>${g.items.map((i) => inboxRow(i, now)).join('')}</section>`)
            .join('')
        : '<div style="font-weight:600">Nothing needs you.</div>'
    }
    <div class="muted" style="font-size:12px;line-height:1.5">
      <div>${repos}</div>
      ${data.failed.map((f) => `<div title="${esc(f.message)}">${esc(f.repoLabel)} could not be read: ${esc(f.message.split('\n')[0])}</div>`).join('')}
    </div>
  </div>`
}

const backButton = (action: string, label: string) =>
  `<div><button class="back" data-action="${action}" style="font-size:13px">‹ ${label}</button></div>`

function factoriesView(): string {
  const key = itemOf(state.place)
  const factory = factoryOf(state.place)
  const target = key ? state.item : factory ? state.board : state.factories
  const f = state.factories
  const hard = (e?: { code: string }) => e && (e.code === 'swamp_not_found' || e.code === 'not_a_swamp_repo')
  if (hard(f.error) || (f.error && !f.data)) return `<div class="body">${errorBox(f.error!)}</div>`
  if (!f.data) return '<div class="body muted">Asking swamp about StageCraft…</div>'
  if (!f.data.installed) return notInstalled()
  if (f.data.factories.length === 0) return noFactories()
  if (target.error && !target.data) return `<div class="body">${factory ? backButton('back', 'Back') : ''}${errorBox(target.error)}</div>`
  const n = key ? 0 : ((factory ? state.board.data?.skipped : f.data.skipped) ?? 0)
  const skipped = n ? `<div class="stale">${n} ticket${n === 1 ? ' is' : 's are'} not shown: StageCraft wrote ${n === 1 ? 'it' : 'them'} in a format this panel does not read. Update Swampling or StageCraft so they match.</div>` : ''
  const stale = (target.error ? `<div class="stale">Showing the last answer. ${esc(target.error.message)}</div>` : '') + skipped
  if (key) return stale + (state.item.data ? itemScreen(state.item.data) : '<div class="body muted">Reading the work item…</div>')
  if (!factory) return stale + factoryList(f.data.factories)
  return stale + (state.board.data ? factoryScreen(state.board.data) : '<div class="body muted">Reading the factory…</div>')
}

function view(): string {
  if (state.switching !== undefined) {
    return `<div class="body muted switching" role="status"><svg width="18" height="18" class="spin" aria-hidden="true"><circle cx="9" cy="9" r="7" fill="none" stroke="var(--dim)" stroke-width="2"/><path d="M9 2a7 7 0 0 1 7 7" fill="none" stroke="var(--muted)" stroke-width="2" stroke-linecap="round"/></svg>Loading ${esc(state.switching || 'workspace')}…</div>`
  }
  const res = state.resolution
  if (!res.data) {
    if (res.error) return `<div class="body">${errorBox(res.error)}</div>`
    return `<div class="body muted">Finding the swamp repo…</div>`
  }
  if (!repoDir()) return header() + repoPicker(res.data.workspace ? 'No swamp repo for this workspace' : 'Swamp repos', res.data)
  if (state.place.tab === 'inbox') return header() + sectionTabs() + inboxView()
  if (state.place.tab === 'stagecraft') return header() + sectionTabs() + factoriesView()
  const onRun = 'workflow' in state.place
  const target = onRun ? state.run : state.list
  if (target.error && (!target.data || target.error.code === 'swamp_not_found' || target.error.code === 'not_a_swamp_repo')) {
    return header() + `<div class="body">${onRun ? backButton('back', 'Back') : ''}${errorBox(target.error)}</div>`
  }
  const stale = target.error ? `<div class="stale">Showing the last answer. ${esc(target.error.message)}</div>` : ''
  if (!onRun) return header() + sectionTabs() + stale + (state.list.data ? listScreen(state.list.data) : '<div class="body muted">Asking swamp…</div>')
  return header() + sectionTabs() + stale + (state.run.data ? runScreen(state.run.data) : '<div class="body muted">Asking swamp…</div>')
}


const root = document.createElement('div')
root.className = 'root'

// Buttons have no id, so a focused one is found again by its data attributes after the page is redrawn.
const focusKey = (el: Element | null): string =>
  el instanceof HTMLElement && root.contains(el) ? el.id || (el.dataset.action ? JSON.stringify(el.dataset) : '') : ''

// The run screen's live log. Its element is made once and outlives every redraw: `render` redraws the page around
// it and new lines are appended to it, so its scroll position and a selection in it survive the poll.
const newTail = (key: string) => ({
  key,
  lines: [] as LogLine[],
  /** The byte offsets the lines span; `next` is none before the first answer. */
  from: 0,
  next: undefined as number | undefined,
  done: false,
  error: undefined as string | undefined,
  asking: false,
  /** The view follows the newest line until the person scrolls up. */
  pinned: true,
  top: 0,
  /** The log tag of the step whose lines show; every line without one. */
  filter: undefined as string | undefined,
  /** A line to scroll to on the next draw: a failed run's first error. */
  seek: undefined as HTMLElement | undefined,
  /** The step each log tag belongs to, which names a line better than its model, whose name may hold the run's id. */
  steps: new Map<string, string>()
})
let tail = newTail('')
const tailKey = (run: Run): string => `${repoDir() ? repoKey(repoDir()!) : ''}\0${run.id}`

const logBox = document.createElement('section')
logBox.className = 'section'
logBox.innerHTML = `<div class="log-head"></div>
  <div class="log-wrap"><div class="log live" role="log" aria-label="Run log" tabindex="0"><div class="log-top"></div><div class="lines"></div></div>
  <button class="btn-outline jump" data-action="logJump" hidden>Jump to latest ↓</button></div>`
const [logHead, logScroll, logTop, logLines, logJump] = ['.log-head', '.log', '.log-top', '.lines', '.jump'].map((q) => logBox.querySelector<HTMLElement>(q)!)
const atBottom = (): boolean => logScroll.scrollHeight - logScroll.scrollTop - logScroll.clientHeight < 24
logScroll.addEventListener(
  'scroll',
  () => {
    tail.pinned = atBottom()
    tail.top = logScroll.scrollTop
    logJump.hidden = tail.pinned
  },
  { passive: true }
)

const clock = (at?: string): string => (at ? `${new Date(at).toLocaleTimeString('en-GB')} ` : '')
// Log text is what a workflow printed: every part of it is escaped.
const lineHtml = (l: LogLine): string =>
  `<div class="ll ${l.level}"${l.tag ? ` data-tag="${esc(l.tag)}"` : ''}${tail.filter && l.tag !== tail.filter ? ' hidden' : ''}><span class="lt">${clock(l.at)}</span>${l.tag ? `<span class="lg">${esc(tail.steps.get(l.tag) ?? l.tag.split('·')[0])} </span>` : ''}${l.level === 'info' ? verdicts(esc(l.text)) : esc(l.text)}</div>`

function takeChunk(chunk: LogChunk, earlier: boolean, run: Run): void {
  const first = tail.next === undefined
  if (chunk.reset) {
    tail.lines = []
    logLines.innerHTML = ''
  }
  // Asked of the element itself: a scroll event may not have told `pinned` of the last wheel turn yet.
  if (logBox.isConnected && !first) tail.pinned = atBottom()
  const html = chunk.lines.map(lineHtml).join('')
  const height = logScroll.scrollHeight
  if (earlier) {
    tail.lines.unshift(...chunk.lines)
    tail.from = chunk.from
    logLines.insertAdjacentHTML('afterbegin', html)
    logScroll.scrollTop += logScroll.scrollHeight - height
    return
  }
  tail.lines.push(...chunk.lines)
  logLines.insertAdjacentHTML('beforeend', html)
  if (first || chunk.reset) tail.from = chunk.from
  tail.next = chunk.next
  tail.done = chunk.done
  // A person reading older lines keeps them for twice as long before the oldest go.
  const over = tail.lines.length - LOG.keepLines * (tail.pinned ? 1 : 2)
  if (over > 0) {
    const before = logScroll.scrollHeight
    tail.lines.splice(0, over)
    for (let i = 0; i < over; i++) logLines.firstElementChild!.remove()
    tail.from = tail.lines[0].pos
    if (!tail.pinned) logScroll.scrollTop -= before - logScroll.scrollHeight
  }
  if (first && run.status === 'failed') {
    const error = tail.lines.findIndex((l) => l.level === 'error')
    if (error >= 0) tail.seek = logLines.children[error] as HTMLElement
  }
  if (tail.pinned) logScroll.scrollTop = logScroll.scrollHeight
}

/** Reads what the run logged since the last read, or with `earlier` the lines before the oldest one held. */
async function loadTail(run: Run, dir: Repo, earlier = false): Promise<void> {
  if (tail.key !== tailKey(run)) {
    tail = newTail(tailKey(run))
    logLines.innerHTML = ''
    logJump.hidden = true
  }
  const t = tail
  t.steps = new Map(stepsOf(run).flatMap((s) => (s.logTag ? [[s.logTag, s.name]] : [])))
  // A run that ended is read to its end once, and one whose process is gone will write no more.
  if (t.asking || (!earlier && t.next !== undefined && (run.gone || (t.done && !inFlight(run.status))))) return
  t.asking = true
  try {
    // A backlog longer than one answer is read in a few asks now, not one per poll.
    for (let i = 0; i < 4; i++) {
      const chunk = await orca.plugin.request('log.tail', { repo: dir, runId: run.id, ...(earlier ? { before: t.from } : t.next !== undefined && { after: t.next }) })
      if (t !== tail) return
      takeChunk(chunk, earlier, run)
      if (earlier || chunk.next >= chunk.size) break
    }
    t.error = undefined
  } catch (e) {
    t.error = failure(e).message
  } finally {
    t.asking = false
    if (t === tail) syncLog()
  }
}

let logDrawn = ['', '']
/** Draws what surrounds the log's lines, and with `place` puts its scroll back after its element moved. */
function syncLog(place = false): void {
  const run = state.run.data
  if (!run || !logBox.isConnected || tail.key !== tailKey(run)) return
  const step = stepsOf(run).find((s) => s.name === state.selected)
  const filter = step?.logTag
  if (filter !== tail.filter) {
    tail.filter = filter
    for (const el of Array.from(logLines.children) as HTMLElement[]) el.hidden = !!filter && el.dataset.tag !== filter
    tail.pinned = place = true
  }
  logBox.toggleAttribute('data-filtered', !!filter)
  const shown = filter ? tail.lines.filter((l) => l.tag === filter).length : tail.lines.length
  const live = inFlight(run.status)
  const status = tail.error
    ? `<span style="color:var(--fail)">${esc(tail.error)}</span>`
    : tail.next === undefined
      ? 'Reading the log…'
      : run.gone
        ? 'not following: the run’s process is gone'
        : live
          ? '<span style="color:var(--run)">following</span>'
          : `${shown} line${shown === 1 ? '' : 's'}`
  const head = `<span class="label">LOG</span><span class="muted" role="status" style="font-size:12px">${status}</span>
    ${step && filter ? `<button class="log-filter" data-action="select" data-step="${esc(step.name)}" title="Show every step’s lines">${esc(step.name)} ✕</button>` : ''}
    <button class="btn-outline" style="margin-left:auto;min-height:26px;padding:0 10px" data-action="logCopy" data-flash="logCopy" ${shown ? '' : 'disabled'}>${state.flash?.action === 'logCopy' ? esc(state.flash.text) : 'Copy'}</button>`
  const none = filter ? 'This step wrote no log lines.' : live ? 'No log lines yet.' : 'This run wrote no log lines.'
  const top =
    tail.from > 0
      ? tail.lines.length < LOG.keepLines
        ? `<button class="btn-outline" style="min-height:24px;padding:0 10px;margin-bottom:6px" data-action="logEarlier">Show earlier</button>`
        : `<div class="muted" style="margin-bottom:6px">Showing the newest ${tail.lines.length} lines.</div>`
      : shown || tail.next === undefined
        ? ''
        : `<span class="muted">${none}</span>`
  if (head !== logDrawn[0]) logHead.innerHTML = head
  if (top !== logDrawn[1]) logTop.innerHTML = top
  logDrawn = [head, top]
  if (tail.seek) {
    logScroll.scrollTop = Math.max(0, tail.seek.offsetTop - 32)
    tail.seek = undefined
  } else if (place) logScroll.scrollTop = tail.pinned ? logScroll.scrollHeight : tail.top
  logJump.hidden = tail.pinned = atBottom()
}

/**
 * Redraws the page as `html` around `keep`, which stays in the document in the place of `html`'s `#log-slot`: an
 * element taken out and put back would lose its scroll position and the selection in it. False when it is not on
 * the page now or `html` has no place for it.
 */
function redrawAround(keep: HTMLElement, html: string): boolean {
  if (!root.contains(keep)) return false
  const page = document.createElement('div')
  page.innerHTML = html
  const slot = page.querySelector('#log-slot')
  const depth = (el: Element | null, top: Element): number => (el === top || !el ? 0 : 1 + depth(el.parentElement, top))
  if (!slot || depth(slot, page) !== depth(keep, root)) return false
  for (let [from, to]: Element[] = [keep, slot]; from !== root; [from, to] = [from.parentElement!, to.parentElement!]) {
    const [was, now] = [from.parentElement!, to.parentElement!]
    const old = Array.from(was.childNodes).filter((n) => n !== from)
    const kids = Array.from(now.childNodes)
    const at = kids.indexOf(to)
    from.before(...kids.slice(0, at))
    from.after(...kids.slice(at + 1))
    for (const n of old) n.remove()
    if (was !== root) for (const a of Array.from(now.attributes)) was.setAttribute(a.name, a.value)
  }
  return true
}

let drawn: string | undefined
function render(): void {
  savePlace()
  const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null
  const focused = focusKey(active)
  const caret = active?.id && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null
  const scrolled = new Map(Array.from(root.querySelectorAll<HTMLElement>('[data-keep-scroll]'), (el) => [el.dataset.keepScroll, [el.scrollTop, el.scrollLeft]]))
  const html = view()
  // The same page again is left alone, so a refresh does not drop the text a person selected in a log.
  if (html === drawn) {
    syncLog()
    return syncGrid()
  }
  const kept = redrawAround(logBox, html)
  if (!kept) root.innerHTML = html
  drawn = html
  const slot = kept ? null : root.querySelector('#log-slot')
  slot?.replaceWith(logBox)
  syncLog(!!slot)
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-keep-scroll]'))) [el.scrollTop, el.scrollLeft] = scrolled.get(el.dataset.keepScroll) ?? [0, 0]
  const nowCol = root.querySelector<HTMLElement>('[data-now-col]')?.dataset.nowCol
  if (nowCol && !scrolled.has('ticket-stages')) showStage(Number(nowCol), 'instant')
  syncGrid()
  if (focused) {
    const el = Array.from(root.querySelectorAll<HTMLElement>('[id], [data-action]')).find((x) => focusKey(x) === focused) as HTMLInputElement | undefined
    el?.focus()
    if (el && caret) el.setSelectionRange(caret[0], caret[1])
  }
}


let generation = 0

async function load<T>(key: 'list' | 'run' | 'factories' | 'board' | 'item', fetch: () => Promise<T>): Promise<void> {
  const gen = generation
  try {
    const data = await fetch()
    if (gen === generation) (state[key] as Loadable<T>) = { data }
  } catch (e) {
    if (gen === generation) (state[key] as Loadable<T>) = { data: state[key].data as T | undefined, error: failure(e) }
  }
}

async function loadLogs(run: Run): Promise<void> {
  const step = stepsOf(run).find((s) => s.name === state.selected)
  const dir = repoDir()
  if (!dir || !step?.logTag || state.tab !== 'logs') return
  const key = `${run.id}\0${step.logTag}`
  if (state.logs.key === key && state.logs.value && !isLive(run)) return
  if (state.logs.key !== key) state.logs = { key, value: undefined, error: undefined }
  try {
    const value = await orca.plugin.request('logs.get', { repo: dir, runId: run.id, logTag: step.logTag })
    if (state.logs.key === key) state.logs = { key, value, error: undefined }
  } catch (e) {
    if (state.logs.key === key) state.logs = { key, value: undefined, error: failure(e).message }
  }
}

let inboxAsk = 0

/** Reads the inbox behind what shows; the worker answers what it remembers unless `fresh`. Only the newest ask is kept. */
async function loadInbox(fresh = false): Promise<void> {
  const ask = ++inboxAsk
  const repo = repoDir()
  state.inboxAt = Date.now()
  state.inboxReading = true
  render()
  let answer: Loadable<Inbox>
  try {
    // A first read asks every repo, some over SSH, which can take longer than a request's 30 s.
    answer = { data: await orca.plugin.request('inbox.list', { ...(fresh && { fresh }), ...(repo && { repo }) }, { timeoutMs: 60_000 }) }
  } catch (e) {
    answer = { data: state.inbox.data, error: failure(e) }
  }
  if (ask !== inboxAsk) return
  state.inbox = answer
  state.inboxReading = false
  render()
}

async function refreshFactories(dir: Repo): Promise<void> {
  const gen = generation
  state.factoriesAt = Date.now()
  await load('factories', () => orca.plugin.request('factories.list', { repo: dir }))
  // The person moved on while swamp answered: `state` may now hold another repo, and its screen reads for itself.
  if (gen !== generation) return
  const p = state.place
  if (p.tab !== 'stagecraft') return
  const f = state.factories.data
  if (!f?.installed || f.factories.length === 0) return
  const factory = factoryOf(p)
  if (factory && !f.factories.some((x) => x.name === factory)) return go({ tab: 'stagecraft' })
  const key = itemOf(p)
  if (key) await load('item', () => orca.plugin.request('workitem.get', { repo: dir, key }))
  else if (factory) await load('board', () => orca.plugin.request('factory.board', { repo: dir, factory }))
}

/** When the list was last asked for, and for which repo on screen. */
let listAt = { gen: -1, at: 0 }

async function refresh(): Promise<void> {
  if (!themeSynced || !inboxSynced) syncTheme()
  // A place remembered while the tab was on.
  if (!state.inboxOn && state.place.tab === 'inbox') state.place = home('workflows')
  const dir = repoDir()
  // While switching, the repo held is the last workspace's: asking it would only fetch what must not show.
  if (!dir || state.switching !== undefined) return render()
  const gen = generation
  const p = state.place
  if (state.inboxOn && Date.now() - state.inboxAt >= (p.tab === 'inbox' ? INBOX_MS : BADGE_MS)) void loadInbox()
  if (p.tab === 'stagecraft') {
    await refreshFactories(dir)
    return render()
  }
  if (Date.now() - state.factoriesAt > BADGE_MS) void refreshFactories(dir).then(render)
  if (p.tab === 'inbox') return render()
  const list = () => {
    listAt = { gen, at: Date.now() }
    return load('list', () => orca.plugin.request('workflows.list', { repo: dir }))
  }
  if (!('workflow' in p)) await list()
  else {
    // The run screen shows the list's recent runs, so it reads the list again behind the run, at the idle rate.
    const listIsOld = listAt.gen !== gen || Date.now() - listAt.at >= IDLE_MS
    if (state.list.data && listIsOld) void list().then(() => gen === generation && render())
    await Promise.all([
      load('run', () => orca.plugin.request('run.get', { repo: dir, workflow: p.workflow, ...(p.runId && { runId: p.runId }) })),
      state.list.data ? undefined : list()
    ])
    if (gen !== generation) return
    const run = state.run.data
    if (run) {
      if (state.selected === undefined && run.status === 'failed' && run.jobs.some((j) => j.stages.some((st) => st.length > 1))) {
        state.selected = firstFailed(run)?.name
      }
      if (run.status === 'failed' && state.agent === undefined && !remoteOff(dir, 'send')) {
        state.agent = await orca.plugin.request('agent.terminal', {}).catch(() => null)
      }
      await Promise.all([loadLogs(run), loadTail(run, dir)])
    }
  }
  render()
}

/** Remembers what `state` holds of the repo on screen, without the errors of its last reads. */
function keepData(): void {
  if (!placeOf) return
  savePlace()
  const kept = <T>(l: Loadable<T>): Loadable<T> => (l.data === undefined ? {} : { data: l.data })
  repoData.delete(placeOf)
  repoData.set(placeOf, { list: kept(state.list), run: kept(state.run), factories: kept(state.factories), factoriesAt: state.factoriesAt, board: kept(state.board), item: kept(state.item) })
  if (repoData.size > DATA_KEPT) repoData.delete(repoData.keys().next().value!)
}

/**
 * Makes `key` the repo on screen. Nothing read from the last one may show under this one's header: its data is put
 * away, and the panel opens where the person was in this repo, on what it read there last.
 */
function enterRepo(key: string | undefined): void {
  if (key === placeOf) return
  // Answers still on their way from the last repo are dropped.
  generation++
  keepData()
  // A repo never seen opens on the tab the person is on now.
  const place = key ? placeIn(places, key) : undefined
  clearScreen()
  Object.assign(state, (place && repoData.get(key!)) || noData(), {
    place: place ?? home(state.place.tab),
    studio: { url: undefined, error: undefined },
    search: '',
    runs: key ? runsViewIn(places, key) : ALL_RUNS,
    runsLimit: RUNS_FIRST,
    filter: 'all',
    itemTab: 'now',
    productOpen: {}
  })
  placeOf = key
}

let repoAsk = 0

/** Asks which repo the focused workspace uses, then reads it. What shows meanwhile stays, with the Refresh icon turning. */
async function loadRepo(fetch: () => Promise<Resolution> = () => orca.plugin.request('repo.resolve', {})): Promise<void> {
  const ask = ++repoAsk
  state.refreshing = true
  render()
  let answer: Loadable<Resolution>
  try {
    answer = { data: await fetch() }
  } catch (e) {
    answer = { error: failure(e) }
  }
  // A newer switch is under way; it settles the panel.
  if (ask !== repoAsk) return
  state.resolution = answer
  state.switching = undefined
  if (answer.data && focused !== undefined) {
    resolutions = withResolution(resolutions, focused, answer.data)
    try {
      localStorage.setItem(RESOLUTIONS_KEY, JSON.stringify(resolutions))
    } catch {}
  }
  const after = repoDir()
  const key = after ? repoKey(after) : undefined
  enterRepo(key)
  await refresh()
  if (ask !== repoAsk) return
  state.refreshing = false
  render()
}

function go(place: Place): void {
  generation++
  const from = state.place
  state.place = place
  if (from.tab !== place.tab) state.search = ''
  if (factoryOf(from) !== factoryOf(place)) {
    state.board = {}
    state.filter = 'all'
  }
  if (itemOf(from) !== itemOf(place)) {
    state.item = {}
    state.itemTab = 'now'
    state.productOpen = {}
  }
  clearScreen()
  render()
  void refresh()
}

/** What belongs to the screen the person leaves, and must not show on the next one. */
function clearScreen(): void {
  state.run = {}
  state.selected = undefined
  state.tab = 'logs'
  state.logs = { key: '', value: undefined, error: undefined }
  state.notes = {}
  state.actionError = undefined
  state.acted = undefined
  state.confirm = undefined
  state.form = undefined
  state.agent = undefined
}

function flash(action: string, text: string): void {
  const shown = { action, text }
  state.flash = shown
  render()
  setTimeout(() => {
    if (state.flash !== shown) return
    state.flash = undefined
    render()
  }, 2000)
}

/**
 * Runs a button's request; `fn` gets a check that is false once the person has moved to another screen. `control`
 * names the run control pressed, whose button then says it is busy and shows the error.
 */
async function act(fn: (here: () => boolean) => Promise<void>, control?: string): Promise<void> {
  const gen = generation
  const here = () => gen === generation
  state.busy = true
  state.actionError = undefined
  state.acted = control
  state.confirm = undefined
  render()
  try {
    await fn(here)
  } catch (e) {
    if (here()) state.actionError = failure(e).message
  }
  state.busy = false
  render()
}

/** Starts a run and goes to it, or to the workflow's latest run when swamp has not listed the new one yet. */
async function startRun(repo: Repo, input: { workflow: string; inputs?: Record<string, string>; again?: RunId }, here: () => boolean): Promise<void> {
  const { runId } = await orca.plugin.request('run.start', { repo, ...input }, { timeoutMs: 60_000 })
  // The new run belongs on top of the lists, which are otherwise read again at the idle rate.
  listAt = { gen: -1, at: 0 }
  if (here()) go({ tab: 'workflows', workflow: input.workflow, ...(runId && { runId }) })
}

/** Says what the last press did, in one line under the header. A line that reports success leaves by itself. */
function note(text: string, tone: 'ok' | 'fail'): void {
  const shown = { text, tone }
  state.connect.note = shown
  render()
  if (tone === 'ok') {
    setTimeout(() => {
      if (state.connect.note !== shown) return
      state.connect.note = undefined
      render()
    }, 8000)
  }
}

function openLogin(replaces?: SshHost): void {
  state.themeMenu = false
  Object.assign(state.connect, { open: true, replaces, login: replaces, fault: undefined, error: undefined })
  render()
  const field = document.getElementById('login-field') as HTMLInputElement | null
  field?.focus()
  field?.select()
}

let connectAsk = 0

async function connect(form: 'login' | 'folder'): Promise<void> {
  const c = state.connect
  if (c.pending) return
  const logins = state.resolution.data?.logins ?? []
  const login = form === 'login' ? tidyLogin(loginText()) : ((c.folder.on && logins.includes(c.folder.on) ? c.folder.on : logins[0]) ?? '')
  const dir = form === 'folder' ? c.folder.dir.trim() : undefined
  const ask = ++connectAsk
  const at = focused
  Object.assign(c, { pending: { form, login }, fault: undefined, error: undefined })
  render()
  const failed = (change: Pick<Connect, 'fault' | 'error'>) => {
    Object.assign(c, change, { pending: undefined })
    render()
    const field = document.getElementById(`${form}-field`) as HTMLInputElement | null
    field?.focus()
    field?.select()
  }
  let answer: Connected
  try {
    // Longer than the worker can take: 20 s for ssh, and Orca's servers asked meanwhile.
    answer = await orca.plugin.request('hosts.add', { host: login, ...(dir !== undefined && { dir }), ...(form === 'login' && c.replaces && { replaces: c.replaces }) }, { timeoutMs: 90_000 })
  } catch (e) {
    if (ask === connectAsk && c === state.connect) failed({ error: { form, message: failure(e).message } })
    return
  }
  // Cancel was pressed.
  if (ask !== connectAsk) return
  // The answer is about the workspace focused at the press. For another one, the panel asks again what holds now.
  if (at !== focused || c !== state.connect) return void loadRepo()
  if (!answer.ok) return failed({ fault: { ...answer, form } })
  const { resolution } = answer
  state.connect = { ...newConnect(), done: answer.login }
  const shown = resolution.repo && resolution.candidates.find((x) => repoKey(x.repo) === repoKey(resolution.repo!))
  if (resolution.repo) note(`Connected to ${answer.login}. Showing ${shown ? repoTitle(shown).split(' · ')[0] : resolution.repo.dir}.`, 'ok')
  await loadRepo(async () => resolution)
}

function pin(key: string): void {
  const choice = state.resolution.data?.candidates.find((c) => repoKey(c.repo) === key)
  if (!choice) return
  state.connect.done = undefined
  // A pick of a remote repo asks the host again, which takes seconds: say so at once.
  state.switching = repoTitle(choice)
  state.visiting = undefined
  void loadRepo(() => orca.plugin.request('repo.pin', { repo: choice.repo }, { timeoutMs: 60_000 }))
}

const actions: Record<string, (el: HTMLElement) => void> = {
  refresh: () => {
    void loadInbox(true)
    void loadRepo(() => orca.plugin.request('repo.resolve', { fresh: true }))
  },
  inboxOpen: (el) => {
    const item = state.inbox.data?.items.find((i) => inboxId(i) === el.dataset.item)
    if (!item) return
    const own = state.resolution.data?.repo
    state.visiting = own && repoKey(own) === repoKey(item.repo) ? undefined : { repo: item.repo, label: item.repoLabel }
    enterRepo(repoKey(item.repo))
    go(inboxPlace(item))
  },
  leave: () => {
    state.visiting = undefined
    const own = repoDir()
    enterRepo(own ? repoKey(own) : undefined)
    go(state.place)
  },
  inboxDecide: (el) => {
    const inbox = state.inbox.data
    const id = el.dataset.item!
    const item = inbox?.items.find((i) => inboxId(i) === id)
    if (!inbox || !item) return
    const note = state.notes[id]
    const gateId = el.dataset.gate!
    void act(async () => {
      try {
        if (item.kind === 'gate') {
          const { workflow, runId, step } = item.gate
          await orca.plugin.request('gate.decide', { repo: item.repo, workflow, runId, step, decision: el.dataset.decision as 'approve' | 'reject', ...(note && { note }) }, { timeoutMs: 90_000 })
        } else {
          const done = await orca.plugin.request(
            'workitem.decide',
            { repo: item.repo, key: item.key, gateId, decision: el.dataset.decision as 'approve' | 'decline', ...(note && { note }) },
            { timeoutMs: 150_000 }
          )
          if (done.advanceError) state.actionError = `${item.key} is approved, but it did not move on: ${done.advanceError}`
        }
        delete state.notes[id]
        // The decided gate leaves the list at once; the fresh read behind it puts back whatever still waits.
        const rest = item.kind === 'ticket' && item.gates.length > 1 ? [{ ...item, gates: item.gates.filter((g) => g !== gateId) }] : []
        if (state.inbox.data) state.inbox = { data: { ...state.inbox.data, items: state.inbox.data.items.flatMap((i) => (inboxId(i) === id ? rest : [i])) } }
      } finally {
        // Read again after a refusal too: what the press was for may no longer wait.
        void loadInbox(true)
      }
    })
  },
  pick: (el) => pin(el.dataset.key!),
  go: (el) => go(parsePlace(JSON.parse(el.dataset.place!))),
  back: () => go(parent(state.place)),
  select: (el) => {
    state.selected = state.selected === el.dataset.step ? undefined : el.dataset.step
    render()
    void refresh()
  },
  tab: (el) => {
    state.tab = el.dataset.tab as Tab
    render()
    void refresh()
  },
  decide: (el) => {
    const run = state.run.data
    const dir = repoDir()
    if (!run || !dir) return
    const step = el.dataset.step!
    const note = state.notes[step]
    void act(async (here) => {
      const data = await orca.plugin.request(
        'gate.decide',
        { repo: dir, workflow: run.workflow, runId: run.id, step, decision: el.dataset.decision as 'approve' | 'reject', ...(note && { note }) },
        { timeoutMs: 90_000 }
      )
      void loadInbox(true)
      if (!here()) return
      state.run = { data }
      delete state.notes[step]
    })
  },
  loginAdd: () => openLogin(),
  loginChange: (el) => openLogin(sshHostOf(el.dataset.host) ?? undefined),
  loginClose: () => {
    Object.assign(state.connect, { open: false, replaces: undefined, login: undefined, fault: undefined, error: undefined })
    render()
  },
  loginUse: (el) => {
    state.connect.login = el.dataset.login
    render()
    document.getElementById('login-field')?.focus()
  },
  keyHelp: () => {
    state.connect.help = !state.connect.help
    render()
  },
  folderToggle: () => {
    state.connect.folder.open = !state.connect.folder.open
    render()
    document.getElementById('folder-field')?.focus()
  },
  connectCancel: () => {
    // The worker's ssh ends on its own timer; its answer is dropped when it comes.
    connectAsk++
    const form = state.connect.pending?.form
    state.connect.pending = undefined
    render()
    document.getElementById(`${form}-field`)?.focus()
  },
  loginRemove: (el) => {
    const host = el.dataset.host!
    const at = focused
    state.themeMenu = false
    state.connect.note = { text: `Removing ${host}…`, tone: 'muted' }
    render()
    orca.plugin.request('hosts.remove', { host }, { timeoutMs: 60_000 }).then(
      ({ resolution, unpicked }) => {
        const lost = unpicked === 1 ? ' The workspace that used a repo on it has no repo picked now.' : unpicked ? ` The ${unpicked} workspaces that used a repo on it have no repo picked now.` : ''
        note(`Removed ${host}.${lost}`, 'ok')
        void loadRepo(at === focused ? async () => resolution : undefined)
      },
      (e) => note(`${host} was not removed: ${failure(e).message}`, 'fail')
    )
  },
  run: (el) => {
    const dir = repoDir()
    const workflow = el.dataset.workflow!
    if (!dir) return
    void act(async (here) => {
      const fields = await orca.plugin.request('workflow.inputs', { repo: dir, workflow })
      if (!here()) return
      if (!fields.length) return startRun(dir, { workflow }, here)
      state.form = { workflow, fields, values: Object.fromEntries(fields.flatMap((f) => (f.default === undefined ? [] : [[f.name, f.default]]))) }
    }, `run:${workflow}`)
  },
  runStart: () => {
    const dir = repoDir()
    const form = state.form
    if (!dir || !form) return
    void act((here) => startRun(dir, { workflow: form.workflow, inputs: form.values }, here), `run:${form.workflow}`)
  },
  runClose: () => {
    state.form = undefined
    state.actionError = undefined
    render()
  },
  unconfirm: () => {
    state.confirm = undefined
    render()
  },
  runAct: (el) => {
    const run = state.run.data
    const dir = repoDir()
    if (!run || !dir) return
    const action = el.dataset.runAction as RunAction
    const from = el.dataset.step ? { job: el.dataset.job!, step: el.dataset.step } : undefined
    if (!from && ACTION_LOOK[action].confirm && state.confirm !== action) {
      Object.assign(state, { confirm: action, actionError: undefined })
      return render()
    }
    void act(
      async (here) => {
        if (action === 'again') return startRun(dir, { workflow: run.workflow, again: run.id }, here)
        try {
          const data = await orca.plugin.request('run.act', { repo: dir, workflow: run.workflow, runId: run.id, action, ...(from && { from }) }, { timeoutMs: 90_000 })
          if (here()) state.run = { data }
        } finally {
          listAt = { gen: -1, at: 0 }
        }
      },
      from ? `from:${from.job}/${from.step}` : action
      // Read again after a refusal too: the run may have moved before swamp refused.
    ).then(() => void refresh())
  },
  send: () => {
    const run = state.run.data
    const dir = repoDir()
    if (!run || !dir) return
    void act(async () => {
      const target = await orca.plugin.request('failure.send', { repo: dir, workflow: run.workflow, runId: run.id })
      flash('send', `Sent to ${target.title}`)
    })
  },
  filter: (el) => {
    state.filter = el.dataset.filter as TicketFilter
    render()
  },
  runs: (el) => {
    state.runs = parseRunsView({ ...state.runs, ...JSON.parse(el.dataset.view!) })
    state.runsLimit = RUNS_FIRST
    render()
  },
  moreRuns: () => {
    state.runsLimit += RUNS_MORE
    render()
  },
  clearRuns: () => {
    Object.assign(state, { runs: ALL_RUNS, search: '', runsLimit: RUNS_FIRST })
    render()
  },
  seeStage: (el) => {
    if (el.classList.contains('offscreen')) return showStage(Number(el.dataset.col), 'smooth')
    if (el.dataset.place) go(parsePlace(JSON.parse(el.dataset.place)))
  },
  pageStages: (el) => {
    const scroll = root.querySelector<HTMLElement>('.grid-scroll')
    if (!scroll) return
    const width = scroll.scrollWidth / Number(root.querySelector<HTMLElement>('[data-grid]')!.dataset.cols)
    scroll.scrollBy({ left: Number(el.dataset.dir) * Math.max(1, Math.floor(scroll.clientWidth / width)) * width, behavior: 'smooth' })
  },
  product: (el) => {
    const p = state.item.data?.products.find((x) => productKey(x) === el.dataset.product)
    if (!p) return
    state.productOpen[productKey(p)] = !(state.productOpen[productKey(p)] ?? p.forGate)
    render()
  },
  itemTab: (el) => {
    state.itemTab = el.dataset.tab as ItemTab
    render()
  },
  scDecide: (el) => {
    const dir = repoDir()
    const key = itemOf(state.place)
    if (!dir || !key) return
    const note = state.notes['']
    void act(async (here) => {
      const data = await orca.plugin.request(
        'workitem.decide',
        { repo: dir, key, gateId: el.dataset.gate!, decision: el.dataset.decision as 'approve' | 'decline', ...(note && { note }) },
        { timeoutMs: 150_000 }
      )
      void loadInbox(true)
      if (!here()) return
      state.item = { data }
      state.notes = {}
    })
  },
  studio: () => {
    const dir = repoDir()
    if (!dir) return
    const at = encodeURIComponent
    const key = itemOf(state.place)
    const factory = factoryOf(state.place)
    const page = (url: string) => new URL(key ? `w/${at(key)}` : factory ? `f/${at(factory)}/board` : '', url).href
    const open = async (url: string) => {
      const answer = await Promise.resolve(orca.shell?.openExternal(page(url))).catch(() => undefined)
      state.studio.error = answer?.opened ? undefined : `Studio is running at ${url}. Press Open studio to open it.`
    }
    if (state.studio.url) return void open(state.studio.url).then(render)
    state.studio.error = undefined
    void act(async () => {
      try {
        const { url } = await orca.plugin.request('studio.start', { repo: dir }, { timeoutMs: 60_000 })
        state.studio.url = url
        // The press may have lapsed while studio started; then the next press opens it.
        await open(url)
      } catch (e) {
        state.studio.error = failure(e).message
      }
    })
  },
  logJump: () => {
    logScroll.scrollTop = logScroll.scrollHeight
    logJump.hidden = tail.pinned = true
  },
  logEarlier: () => {
    const [run, dir] = [state.run.data, repoDir()]
    if (run && dir) void loadTail(run, dir, true)
  },
  logCopy: (el) => {
    el.dataset.text = logText(tail.filter ? tail.lines.filter((l) => l.tag === tail.filter) : tail.lines)
    actions.copyText(el)
  },
  copyText: (el) => {
    const text = el.dataset.text!
    void act(async () => {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        await orca.plugin.request('clipboard.copy', { text })
      }
      flash(el.dataset.flash!, 'Copied')
    })
  },
  themeMenu: () => {
    state.themeMenu = !state.themeMenu
    render()
    if (state.themeMenu) document.getElementById(`theme-${state.theme}`)?.focus()
  },
  inboxToggle: () => {
    const on = !state.inboxOn
    inboxSynced = true
    closeThemeMenu()
    applyInbox(on)
    if (on) void loadInbox()
    orca.plugin.request('inbox.enabled', { on }).catch((e) => {
      state.actionError = `The setting did not save: ${failure(e).message}`
      render()
    })
  },
  theme: (el) => {
    const id = parseThemeId(el.dataset.theme)
    themeSynced = true
    applyTheme(id)
    closeThemeMenu()
    orca.plugin.request('theme.set', { theme: id }).catch((e) => {
      state.actionError = `The theme did not save: ${failure(e).message}`
      render()
    })
  },
  copy: () => {
    const run = state.run.data
    const step = run && firstFailed(run)
    if (!run || !step) return
    const text = retryCommand(run, step.name)
    void act(async () => {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        await orca.plugin.request('clipboard.copy', { text })
      }
      flash('copy', 'Copied retry command')
    })
  }
}

root.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')
  if (el && !(el as HTMLButtonElement).disabled) actions[el.dataset.action!]?.(el)
})
// Scroll events do not bubble, so the stage columns' scroll is caught on the way down.
root.addEventListener('scroll', syncGrid, { capture: true, passive: true })
window.addEventListener('resize', syncGrid)
function closeThemeMenu(): void {
  state.themeMenu = false
  render()
  document.getElementById('theme-btn')?.focus()
}
document.addEventListener('click', (e) => {
  if (state.themeMenu && !(e.target as HTMLElement).closest('.theme-menu, #theme-btn')) closeThemeMenu()
})
document.addEventListener('keydown', (e) => {
  if (!state.themeMenu) return
  const items = Array.from(root.querySelectorAll<HTMLElement>('.theme-menu button'))
  const at = items.indexOf(document.activeElement as HTMLElement)
  const move: Record<string, number> = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }
  if (e.key === 'Escape' || e.key === 'Tab') {
    e.preventDefault()
    closeThemeMenu()
  } else if (e.key in move) {
    e.preventDefault()
    items[(move[e.key] + items.length) % items.length]?.focus()
  }
})
root.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement
  if (el.dataset.input === 'search') {
    state.search = el.value
    state.runsLimit = RUNS_FIRST
    render()
  } else if (el.dataset.input === 'note') state.notes[el.dataset.step ?? ''] = el.value
  else if (el.dataset.input === 'field' && state.form) state.form.values[el.dataset.field!] = el.value
  else if (el.dataset.input === 'login' || el.dataset.input === 'folder') {
    if (el.dataset.input === 'login') state.connect.login = el.value
    else state.connect.folder.dir = el.value
    // The button is off while its field is empty, and the key steps name the login typed.
    render()
  }
})
root.addEventListener('submit', (e) => {
  e.preventDefault()
  void connect((e.target as HTMLElement).dataset.form as 'login' | 'folder')
})
root.addEventListener('change', (e) => {
  const el = e.target as HTMLSelectElement
  if (el.dataset.change === 'pick') pin(el.value)
  else if (el.dataset.change === 'folderOn') state.connect.folder.on = sshHostOf(el.value) ?? undefined
})


const statusVars = (c: typeof ORCA_STATUS.dark): string =>
  `--ok: ${c.ok}; --fail: ${c.fail}; --run: ${c.run}; --gold: ${c.gold}; --warm: ${c.warm}; --on-gold: ${c.onGold};`

const style = document.createElement('style')
style.textContent = `
:root {
  --panel: var(--orca-background); --raised: var(--orca-card); --deep: color-mix(in srgb, var(--orca-background) 65%, #000);
  --border: var(--orca-border); --border-strong: color-mix(in srgb, var(--orca-muted-foreground) 30%, transparent);
  --text: var(--orca-foreground); --muted: var(--orca-muted-foreground);
  --dim: color-mix(in srgb, var(--orca-muted-foreground) 55%, var(--orca-background)); --dim-fill: var(--orca-muted);
  --accent: var(--orca-primary); --on-accent: var(--orca-primary-foreground); --ring: var(--orca-ring);
  ${statusVars(ORCA_STATUS.dark)}
  --gold-bg: color-mix(in srgb, var(--gold) 9%, var(--panel)); --ok-bg: color-mix(in srgb, var(--ok) 9%, var(--panel)); --fail-bg: color-mix(in srgb, var(--fail) 9%, var(--panel));
  --sans: Inter, system-ui, -apple-system, sans-serif; --mono: 'JetBrains Mono', SFMono-Regular, Menlo, monospace;
}
html.light { --deep: color-mix(in srgb, var(--orca-background) 94%, #000); ${statusVars(ORCA_STATUS.light)} }
${paletteCss()}
* { box-sizing: border-box; }
body { margin: 0; background: var(--panel); color: var(--text); font: 13px/1.35 var(--sans); overflow-wrap: anywhere; }
button, input, select, textarea { font: inherit; color: inherit; }
button { cursor: pointer; }
button:disabled, input:disabled, select:disabled { cursor: default; opacity: 0.6; }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.root { min-height: 100vh; display: flex; flex-direction: column; }
.mono { font-family: var(--mono); }
.muted { color: var(--muted); }
.sr { position: absolute; left: -9999px; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.app-head { position: relative; padding: 14px 16px 10px; display: flex; align-items: center; gap: 10px; }
.theme-menu { position: absolute; z-index: 10; top: calc(100% - 4px); right: 16px; width: min(300px, calc(100vw - 32px)); padding: 4px; border-radius: 10px; border: 1px solid var(--border-strong); background: var(--raised); box-shadow: 0 10px 28px color-mix(in srgb, #000 35%, transparent); display: flex; flex-direction: column; gap: 2px; }
.theme-item { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border: none; border-radius: 7px; background: none; text-align: left; }
.theme-item:hover, .theme-item:focus { background: var(--panel); outline: none; }
.theme-item[aria-checked="true"] .theme-check { color: var(--accent); }
.theme-check { width: 14px; display: flex; flex-shrink: 0; }
.swatch { display: flex; align-items: center; gap: 3px; padding: 0 6px; height: 24px; border-radius: 6px; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 16%, transparent); flex-shrink: 0; }
.swatch span { width: 9px; height: 9px; border-radius: 50%; }
.repo-select { field-sizing: content; appearance: none; background: none; border: none; padding: 0; color: var(--muted); font-size: 12px; cursor: pointer; max-width: 200px; text-overflow: ellipsis; }
.icon-btn { background: none; border: 1px solid var(--border); color: var(--muted); border-radius: 6px; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.icon-btn:hover { color: var(--text); }
.body { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.section { display: flex; flex-direction: column; gap: 8px; }
.label { font-size: 12px; font-weight: 600; color: var(--muted); letter-spacing: 0.02em; }
.input { width: 100%; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--raised); color: var(--text); }
.input::placeholder { color: var(--muted); }
.card { border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: var(--raised); }
button.card { text-align: left; width: 100%; }
.clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.wf { display: flex; flex-direction: column; gap: 8px; }
button.wf:hover, .row-btn:hover, .recent:hover, .node:hover { border-color: var(--border-strong); }
.row-btn { display: flex; align-items: center; gap: 10px; }
.pill { padding: 2px 8px; border-radius: 10px; border: 1px solid; white-space: nowrap; }
.bar { flex: 1; height: 6px; border-radius: 3px; }
.recent { display: flex; align-items: center; gap: 10px; padding: 8px 4px; border: none; border-bottom: 1px solid var(--border); background: none; text-align: left; width: 100%; }
.recent:hover { background: var(--raised); }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.back { background: none; border: none; color: var(--muted); padding: 4px; min-width: 28px; min-height: 28px; font-size: 16px; }
.back:hover { color: var(--text); }
.chip { font-size: 11.5px; padding: 3px 8px; border-radius: 6px; background: var(--raised); color: var(--muted); }
.timeline { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; }
.step-row { display: flex; justify-content: space-between; gap: 8px; background: none; border: none; padding: 1px 0 0; text-align: left; width: 100%; }
.step-row:hover .mono { text-decoration: underline; text-decoration-color: var(--border-strong); }
.detail { border: 1px solid var(--border); border-radius: 8px; background: var(--deep); overflow: hidden; }
.step-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.step-about { padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.clamp2 { -webkit-line-clamp: 2; }
.detail-head { padding: 10px 12px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; }
.tabs { display: flex; border-bottom: 1px solid var(--border); }
.tab { background: none; border: none; border-bottom: 2px solid transparent; color: var(--muted); padding: 7px 12px; font-size: 12px; }
.tab[aria-selected="true"] { border-bottom-color: var(--accent); color: var(--text); }
.log { margin: 0; padding: 10px 12px; font: 11.5px/1.6 var(--mono); color: var(--muted); white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto; }
.log-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-height: 28px; }
.log-wrap { position: relative; border: 1px solid var(--border); border-radius: 8px; background: var(--deep); overflow: hidden; }
.log.live { position: relative; min-height: 44px; max-height: 360px; color: var(--text); user-select: text; }
.ll.warn { color: var(--warm); }
.ll.error { color: var(--fail); }
.lt, .lg { color: var(--dim); }
[data-filtered] .lg { display: none; }
.log-filter { border: 1px solid var(--border-strong); border-radius: 6px; background: var(--raised); color: var(--text); font-size: 11.5px; padding: 2px 8px; }
.jump[hidden] { display: none; }
.jump { position: absolute; right: 14px; bottom: 8px; min-height: 26px; padding: 0 10px; background: var(--raised); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35); }
.node { width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--raised); text-align: left; }
.node-col { flex-direction: column; align-items: stretch; gap: 4px; }
.parallel { width: 100%; display: grid; gap: 10px; }
.gate { border: 1px solid var(--gold); border-radius: 10px; padding: 14px; background: var(--gold-bg); display: flex; flex-direction: column; gap: 10px; }
.note { font-size: 13px; resize: none; padding: 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--deep); color: var(--text); }
.btn-gold { border-radius: 8px; border: none; background: var(--gold); color: var(--on-gold); font-weight: 600; }
.btn-outline { border-radius: 8px; border: 1px solid var(--border-strong); background: none; color: var(--text); }
.btn-outline:hover { background: var(--raised); }
.btn-danger { border-radius: 8px; border: 1px solid var(--fail); background: var(--fail-bg); color: var(--fail); font-weight: 600; }
.ctls { display: flex; flex-wrap: wrap; gap: 8px; }
.ctl { min-height: 30px; padding: 0 12px; font-size: 12.5px; }
.btn-accent.ctl { min-height: 30px; }
.ctl-error { color: var(--fail); font-size: 12px; white-space: pre-wrap; }
.ask { border: 1px solid var(--border-strong); border-radius: 10px; padding: 10px 12px; background: var(--raised); display: flex; flex-direction: column; gap: 8px; font-size: 12.5px; line-height: 1.45; }
.run-form { border: 1px solid var(--border-strong); border-radius: 10px; padding: 12px; background: var(--raised); display: flex; flex-direction: column; gap: 10px; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.with-from { display: flex; align-items: flex-start; gap: 8px; min-width: 0; flex-wrap: wrap; }
.with-from > .node { flex: 1; width: auto; min-width: 0; }
.with-from > .step-row { flex: 1; width: auto; min-width: 0; }
.with-from.col { flex-direction: column; align-items: stretch; gap: 4px; }
.with-from .ctl-error { flex-basis: 100%; }
.from { min-height: 24px; padding: 0 8px; font-size: 11.5px; white-space: nowrap; flex-shrink: 0; }
.from.quiet { opacity: 0; }
.with-from:hover .from.quiet, .from.quiet:focus-visible { opacity: 1; }
.btn-accent { min-height: 38px; border-radius: 8px; border: none; background: var(--accent); color: var(--on-accent); font-weight: 600; }
.link { background: none; border: none; padding: 4px 0; color: var(--muted); font-size: 12px; text-align: left; text-decoration: underline; text-underline-offset: 3px; }
.link:hover { color: var(--text); }
.steps { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 8px; font-size: 12px; line-height: 1.45; color: var(--muted); }
.steps .copy-row { margin-top: 4px; color: var(--text); }
.said { font-size: 11.5px; color: var(--muted); }
.menu-label { margin-top: 2px; padding: 8px 8px 2px; border-top: 1px solid var(--border); font-size: 11px; font-weight: 600; color: var(--muted); letter-spacing: 0.02em; }
.menu-row { display: flex; align-items: center; gap: 8px; padding: 3px 8px; min-width: 0; }
.stale { margin: 0 16px; padding: 8px 10px; border-radius: 8px; font-size: 12px; color: var(--gold); background: var(--gold-bg); }
.note-ok { color: var(--ok); background: var(--ok-bg); }
.note-fail { color: var(--fail); background: var(--fail-bg); }
.note-muted { color: var(--muted); background: var(--raised); }
.segs { margin: 0 16px; display: flex; background: var(--raised); border-radius: 8px; padding: 3px; }
.seg { flex: 1 1 auto; white-space: nowrap; border: none; border-radius: 6px; padding: 7px 4px; background: none; color: var(--muted); }
.seg[aria-selected="true"] { background: var(--panel); color: var(--text); font-weight: 500; }
.copy-row { display: flex; gap: 8px; align-items: center; padding: 8px 10px; border-radius: 8px; background: var(--deep); border: 1px solid var(--border); }
.copy-row code { flex: 1; min-width: 0; font-size: 11.5px; overflow-wrap: anywhere; }
.studio { min-height: 32px; padding: 0 10px; display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.fchip { padding: 5px 10px; border-radius: 14px; border: 1px solid var(--border); background: none; color: var(--muted); font-size: 12px; }
.fchip[aria-pressed="true"] { border-color: var(--c); color: var(--text); background: color-mix(in srgb, var(--c) 14%, var(--panel)); }
.fchip.tight { padding: 3px 8px; font-size: 11.5px; white-space: nowrap; }
.fchip .n { opacity: 0.75; font-variant-numeric: tabular-nums; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; }
#sort { margin-left: auto; }
.pager { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
.pager[hidden] { display: none; }
.pager .icon-btn { width: 28px; height: 28px; font-size: 15px; }
.grid { position: relative; display: flex; font-size: 12px; }
.grid-names { flex: 0 0 120px; min-width: 0; display: flex; flex-direction: column; }
.grid-scroll { flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: thin; padding-bottom: 6px; }
.grid-cols { display: grid; grid-auto-rows: 44px; grid-template-rows: 24px; align-items: center; justify-items: center; }
.grid-head { height: 24px; display: flex; align-items: flex-end; font-size: 10.5px; }
.grid-head.stage { color: var(--muted); max-width: 100%; display: block; line-height: 24px; text-align: center; }
.grid-head.runs { text-decoration: underline dotted; text-underline-offset: 3px; }
.grid-row { height: 44px; }
button.cell { width: 100%; border: none; background: none; padding: 0; display: flex; align-items: center; justify-content: center; border-radius: 6px; cursor: pointer; }
button.cell:hover { background: var(--raised); }
.name-cell { display: flex; flex-direction: column; justify-content: center; min-width: 0; padding-right: 8px; }
.tname { border: none; background: none; padding: 0; text-align: left; font-weight: 600; }
.tname:hover { text-decoration: underline; text-decoration-color: var(--border-strong); }
.tline { border: none; background: none; padding: 0; text-align: left; font-size: 11px; display: flex; min-width: 0; max-width: 100%; }
.tlabel { white-space: pre; flex-shrink: 0; }
.off { flex-shrink: 0; padding-left: 3px; }
.grid:not(.wide) .where, .grid.wide .when, .tline:not(.offscreen) .off { display: none; }
.cell { display: flex; align-items: center; justify-content: center; }
.grid-fade { position: absolute; right: 0; top: 0; bottom: 6px; width: 40px; pointer-events: none; background: linear-gradient(90deg, transparent, var(--panel)); display: none; }
.grid.wide:not(.at-end) .grid-fade { display: block; }
.mk { display: inline-block; flex-shrink: 0; }
.mk-pass { width: 10px; height: 10px; border-radius: 50%; background: var(--ok); }
.mk-ahead { width: 8px; height: 8px; border-radius: 50%; border: 1px solid var(--border-strong); }
.mk-now { width: 14px; height: 14px; border-radius: 50%; background: var(--c); box-shadow: 0 0 0 3px color-mix(in srgb, var(--c) 18%, transparent); }
.mk-now.needs-you { border-radius: 3px; }
.mk-now.stuck { width: 12px; height: 12px; border-radius: 2px; transform: rotate(45deg); }
.mk-now.queued { background: none; border: 2px solid var(--c); box-shadow: none; }
.mk-text { font-size: 10px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: 11.5px; color: var(--muted); }
.legend > span { display: flex; align-items: center; gap: 5px; }
.legend .mk { transform: scale(0.65); }
.legend .mk.stuck { transform: scale(0.65) rotate(45deg); }
.exit { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.product { display: flex; justify-content: space-between; gap: 10px; padding: 8px 10px; border-radius: 8px; background: var(--raised); }
button.product { width: 100%; border: none; text-align: left; }
button.product:hover { box-shadow: 0 0 0 1px var(--border-strong); }
.payload { padding: 10px 12px; display: flex; flex-direction: column; gap: 12px; max-height: 360px; overflow: auto; font-size: 12.5px; }
.payload-list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 8px; }
.payload-fields { display: grid; grid-template-columns: minmax(0, max-content) minmax(0, 1fr); gap: 4px 10px; overflow-wrap: anywhere; }
.metric { padding: 10px; border-radius: 8px; border: 1px solid var(--border); }
.journal { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.journal li { display: grid; grid-template-columns: 56px 90px 1fr; gap: 8px; padding: 7px 0; border-bottom: 1px solid var(--border); font-size: 12px; align-items: baseline; }
.spin { animation: spin 1.2s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
.switching { flex-direction: row; align-items: center; justify-content: center; gap: 8px; min-height: 160px; }
`
document.head.append(style)
document.body.append(root)


function nextDelay(): number {
  if (state.place.tab !== 'workflows') return IDLE_MS
  // A run whose process is gone will not move by itself, so it is not read at the fast rate.
  if ('workflow' in state.place) return state.run.data && isLive(state.run.data) && !state.run.data.gone ? LIVE_MS : IDLE_MS
  return state.list.data?.workflows.some((w) => w.latest?.status === 'running' || w.latest?.status === 'pending') ? LIVE_MS : IDLE_MS
}

let heldForSelect = false
async function tick(): Promise<void> {
  try {
    // Redrawing replaces an open <select>, which would close its dropdown under the person's pointer. A focused
    // select may also be closed, and nothing reports that, so hold off one poll only.
    const select = document.activeElement instanceof HTMLSelectElement && !heldForSelect
    heldForSelect = select
    if (!document.hidden && !state.busy && !select) await refresh()
  } finally {
    setTimeout(tick, nextDelay())
  }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !state.busy) void refresh()
})

let focused: string | undefined
orca.on('workspace.changed', ({ context }) => {
  const key = workspaceKey(context)
  if (focused !== undefined && key !== focused) {
    // Send types into a terminal of the focused workspace, so ask again which one.
    state.agent = undefined
    state.visiting = undefined
    // The forms and their messages are about the workspace left behind.
    state.connect = newConnect()
    const known = resolutionIn(resolutions, key)
    if (known) {
      // What this workspace showed last shows at once; the answer on its way replaces it.
      state.resolution = { data: known }
      state.switching = undefined
      enterRepo(known.repo ? repoKey(known.repo) : undefined)
    } else state.switching = context?.displayName ?? ''
    void loadRepo()
  }
  // The same workspace with its terminals renamed: ask again which one Send types into.
  else if (state.agent !== undefined) {
    state.agent = undefined
    if (!state.busy) void refresh()
  }
  focused = key
})
restorePlace()
applyTheme(savedThemeHint())
state.inboxOn = savedInboxHint()
render()
syncTheme()
void loadRepo().finally(() => setTimeout(tick, nextDelay()))
