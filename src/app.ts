import { HISTORY_LENGTH, isLive, RECENT_LENGTH, repoKey, type LogText, type RecentRun, type Repo, type Run, type RunId, type RunStatus, type Step, type WorkflowSummary } from './domain'
import {
  ago,
  approveCommand,
  home,
  parent,
  workspaceKey,
  parsePlace,
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
  type Tone
} from './present'
import type { AgentTerminal, ListData } from './protocol'
import type { Resolution } from './repo'
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
  search: '',
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
  switching: undefined as string | undefined
}

// The frame can reload when Orca remounts the panel, so the place survives in localStorage, with the repo it is in.
const PLACE_KEY = 'orca-swamp.place'
let placeRepo: string | undefined
function restorePlace(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(PLACE_KEY) ?? '{}')
    state.place = parsePlace(saved.place)
    placeRepo = typeof saved.repo === 'string' ? saved.repo : undefined
  } catch {}
}
function savePlace(): void {
  const repo = repoDir()
  if (!repo) return
  try {
    localStorage.setItem(PLACE_KEY, JSON.stringify({ place: state.place, repo: repoKey(repo) }))
  } catch {}
}

const placeAttr = (place: Place): string => `data-place="${esc(JSON.stringify(place))}"`
/** The attributes of a button that goes to `place`. */
const goTo = (place: Place): string => `data-action="go" ${placeAttr(place)}`

// The worker's settings file is the record; this copy only paints the saved theme before the worker answers.
const THEME_KEY = 'orca-swamp.theme'
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

// Asked again on each refresh until it answers: right after a plugin reload the worker may not be up yet.
let themeSynced = false
function syncTheme(): void {
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
  </div>`
}

const repoDir = (): Repo | null => state.resolution.data?.repo ?? null
const factoryOf = (p: Place): string | undefined => ('factory' in p ? p.factory : undefined)
const itemOf = (p: Place): string | undefined => ('item' in p ? p.item : undefined)


function header(): string {
  const res = state.resolution.data
  const key = res?.repo ? repoKey(res.repo) : ''
  const current = res?.candidates.find((c) => repoKey(c.repo) === key)
  const label = current ? repoTitle(current) : key
  const version = state.list.data?.version ? ` · swamp ${esc(state.list.data.version.split('.')[0])}` : ''
  const picker =
    res?.repo && res.candidates.length > 1
      ? `<select class="repo-select" data-change="pick" aria-label="Swamp repo">${res.candidates
          .map((c) => `<option value="${esc(repoKey(c.repo))}" ${repoKey(c.repo) === key ? 'selected' : ''}>${esc(repoTitle(c))}</option>`)
          .join('')}</select>`
      : esc(label)
  return `<header class="app-head">
    ${LOGO}
    <div style="flex:1;min-width:0">
      <div style="font-weight:600;font-size:14px">Swamp</div>
      <div class="muted" style="font-size:12px;display:flex;align-items:center">${picker}<span>${version ? `&nbsp;${version.slice(1)}` : ""}</span></div>
    </div>
    <button class="icon-btn" data-action="refresh" aria-label="Refresh">${REFRESH}</button>
    <button class="icon-btn" id="theme-btn" data-action="themeMenu" aria-label="Theme" aria-haspopup="menu" aria-expanded="${state.themeMenu}">${GEAR}</button>
    ${state.themeMenu ? themeMenu() : ''}
  </header>`
}

const PROBLEM_TITLE: Record<string, string> = {
  host_unreachable: 'cannot connect over SSH',
  orca_cli_missing: 'orca command not found',
  swamp_not_found: 'swamp is not installed there',
  timeout: 'swamp timed out'
}

function errorBox(e: { code: string; message: string }): string {
  const res = state.resolution.data
  if (e.code === 'not_a_swamp_repo' && res) return repoPicker('This folder is not a swamp repo', res)
  const missing = e.code === 'swamp_not_found'
  return `<div class="card" style="border-color:var(--fail);background:var(--fail-bg);display:flex;flex-direction:column;gap:8px">
    <div style="font-weight:600">${missing ? 'swamp CLI not found' : esc(PROBLEM_TITLE[e.code] ?? 'swamp failed')}</div>
    <div class="muted" style="line-height:1.5;overflow-wrap:anywhere">${esc(e.message)}</div>
    ${missing ? '<div class="muted" style="font-size:12px">Install swamp so it is on your PATH or in ~/.local/bin, then retry.</div>' : ''}
    <div><button class="btn-outline" data-action="refresh" style="min-height:32px;padding:0 12px">Retry</button></div>
  </div>`
}

function repoPicker(title: string, res: Resolution): string {
  const unlisted = res.workspace && !res.workspace.listed
  const shared = res.workspace?.sharedName
  const hosts = res.remoteHosts ?? []
  return `<div class="body">
    ${
      res.problem
        ? `<div class="card" style="border-color:var(--fail);background:var(--fail-bg);display:flex;flex-direction:column;gap:6px;margin-bottom:12px">
            <div style="font-weight:600">Remote repos: ${esc(PROBLEM_TITLE[res.problem.code] ?? 'swamp failed')}</div>
            <div class="muted" style="line-height:1.5;overflow-wrap:anywhere">${esc(res.problem.message)}</div>
            <div><button class="btn-outline" data-action="refresh" style="min-height:32px;padding:0 12px">Retry</button></div>
          </div>`
        : !res.workspace && hosts.length
        ? `<div class="card" style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">
            <div style="font-weight:600">Is this a workspace on ${esc(hosts.join(', '))}?</div>
            <div class="muted" style="line-height:1.5">Orca does not tell plugins which remote workspace is focused. Pick its swamp repo below; the panel runs swamp there over SSH and remembers the pick for remote workspaces.</div>
          </div>`
        : shared
        ? `<div class="card" style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">
            <div style="font-weight:600">${shared} workspaces are named ${esc(res.workspace!.name)}</div>
            <div class="muted" style="line-height:1.5">Orca tells plugins which one is focused only through its terminals, and this one has none. Open a terminal in it and the panel finds its repo, or pick one below for now.</div>
          </div>`
        : unlisted
        ? `<div class="card" style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">
            <div style="font-weight:600">${esc(res.workspace!.name)} is not visible to plugins</div>
            <div class="muted" style="line-height:1.5">Orca does not give plugins this workspace, so the panel cannot read its swamp repo. Run <span class="mono">swamp</span> in that workspace's terminal, or pick a repo below.</div>
          </div>`
        : ''
    }
    <section class="section">
      <div class="label">${esc(title.toUpperCase())}</div>
      ${
        res.candidates.length === 0
          ? '<div class="muted" style="line-height:1.5">No folder in your Orca workspaces has a <span class="mono">.swamp.yaml</span>. Open a swamp repo as a workspace, then refresh.</div>'
          : `<div class="muted" style="font-size:12px;margin-bottom:4px">Pick the swamp repo this workspace uses.${shared ? '' : ' The panel remembers it.'}</div>
             ${res.candidates
               .map(
                 (c) => `<button class="card row-btn" data-action="pick" data-key="${esc(repoKey(c.repo))}">
                   ${LOGO}<span style="flex:1;min-width:0;text-align:left"><span class="mono" style="font-weight:600">${esc(repoTitle(c))}</span><br><span class="muted" style="font-size:12px;overflow-wrap:anywhere">${esc(repoKey(c.repo))}</span></span></button>`
               )
               .join('')}`
      }
    </section>
  </div>`
}

const matches = (...fields: (string | undefined)[]) => {
  const q = state.search.trim().toLowerCase()
  return !q || fields.some((f) => f?.toLowerCase().includes(q))
}

const runTone = (s: RunStatus): string => TONE_VAR[runLook(s).tone]

function workflowCard(w: WorkflowSummary, now: number): string {
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
      <span>${w.steps} step${w.steps === 1 ? '' : 's'}</span>${w.latest?.trigger ? `<span>${esc(w.latest.trigger)}</span>` : ''}
      <span style="margin-left:auto">${w.latest ? ago(w.latest.startedAt, now) : ''}</span>
    </div>
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

const runRow = (r: RecentRun, name: string, now: number, current?: RunId): string =>
  recentRow({
    place: r.runId === current ? null : { tab: 'workflows', workflow: r.workflow, runId: r.runId },
    color: runTone(r.status),
    name,
    detail: r.input ?? shortId(r.runId),
    status: `${runLook(r.status).text.toLowerCase()} · ${since(r.startedAt, now)}`
  })

function listScreen(data: ListData): string {
  const now = Date.now()
  const gates = data.gates.filter((g) => matches(g.workflow, g.step, g.input))
  const workflows = data.workflows.filter((w) => matches(w.name, w.description))
  const recent = data.recent.filter((r) => matches(r.workflow, r.input))
  return `<div class="body" style="gap:18px">
    <label><span class="sr">Search workflows</span>
      <input id="search" type="search" class="input" placeholder="Search workflows and runs" value="${esc(state.search)}" data-input="search">
    </label>
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
    ${
      workflows.length === 0
        ? `<section class="section"><div class="label">WORKFLOWS · 0</div><div class="muted">${data.workflows.length ? 'No workflow matches.' : 'This repo has no workflows yet.'}</div></section>`
        : groupWorkflows(workflows)
            .map(
              (g) => `<section class="section">
        <div class="label">${esc(g.title.toUpperCase())} · ${g.workflows.length}</div>
        ${g.workflows.map((w) => workflowCard(w, now)).join('')}
      </section>`
            )
            .join('')
    }
    ${
      recent.length
        ? `<section class="section" style="gap:2px">
        <div class="label" style="margin-bottom:6px">RECENT RUNS</div>
        ${recent.map((r) => runRow(r, r.workflow, now)).join('')}
      </section>`
        : ''
    }
  </div>`
}

const verdicts = (html: string): string =>
  html
    .replace(/\b(ok|pass|passed)$/, '<span style="color:var(--ok)">$1</span>')
    .replace(/\b(FAIL|FAILED|failed)\b/, '<span style="color:var(--fail)">$1</span>')

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
    <div role="tablist" class="tabs">
      ${tabs.map(([id, label]) => `<button role="tab" aria-selected="${state.tab === id}" class="tab" data-action="tab" data-tab="${id}">${label}</button>`).join('')}
    </div>
    <pre class="log" data-keep-scroll="log">${body}</pre>
  </section>`
}

function timeline(run: Run, steps: Step[]): string {
  const now = Date.now()
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
            <button class="step-row" data-action="select" data-step="${esc(s.name)}" aria-expanded="${open}">
              <span class="mono" style="font-size:12.5px;color:${s.status === 'pending' || s.status === 'skipped' ? 'var(--muted)' : 'var(--text)'}">${esc(s.name)}</span>
              <span class="muted" style="font-size:12px">${esc(stepTime(s, now))}</span>
            </button>
            ${open ? stepDetail(run, s, false) : ''}
          </div>
        </li>`
      })
      .join('')}
  </ol>`
}

function stepCard(s: Step, wide: boolean, now: number): string {
  const tone = stepTone(s)
  const border =
    tone === 'fail' ? 'border-color:var(--fail);background:var(--fail-bg)' : tone === 'wait' ? 'border-color:var(--gold);background:var(--gold-bg)' : tone === 'run' ? 'border-color:var(--run)' : ''
  const quiet = s.status === 'pending' || s.status === 'skipped'
  const style = `${quiet ? 'border-style:dashed;background:none;color:var(--muted)' : ''};${border}${state.selected === s.name ? ';box-shadow:0 0 0 1px var(--ring)' : ''}`
  const time = stepTime(s, now)
  if (wide) {
    return `<button class="node" style="${style}" data-action="select" data-step="${esc(s.name)}">
      ${icon(s, 16)}<span class="mono" style="font-size:12.5px">${esc(s.name)}</span>
      <span style="margin-left:auto;font-size:12px;color:var(--muted)">${esc(time)}</span>
    </button>`
  }
  const caption =
    s.status === 'failed' ? [s.error.split('\n')[0], time].filter(Boolean).join(' · ') : s.status === 'waiting' ? `waiting ${time}` : time
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
  const out: string[] = []
  run.jobs.forEach((job, j) => {
    if (run.jobs.length > 1) out.push(`<div class="label" style="margin:${j ? 12 : 0}px 0 6px">${esc(job.name.toUpperCase())}</div>`)
    job.stages.forEach((stage, i) => {
      const next = job.stages[i + 1]
      if (stage.length === 1) out.push(stepCard(stage[0], true, now))
      else {
        const cols = Math.min(stage.length, 2)
        out.push(`<div class="parallel" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${stage.map((s) => stepCard(s, false, now)).join('')}</div>`)
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
    ${state.actionError ? `<div style="color:var(--fail);font-size:12px">${esc(state.actionError)}</div>` : ''}
    <div class="mono muted" style="font-size:11.5px;overflow-wrap:anywhere">runs: ${esc(approveCommand(run.workflow, step.name, run.id))}</div>`
    }
  </div>`
}

function failureActions(run: Run, step: Extract<Step, { status: 'failed' }>): string {
  const repo = repoDir()
  const off = repo && remoteOff(repo, 'send')
  const agent = off ? null : state.agent
  const flash = (action: string, text: string) => (state.flash?.action === action ? esc(state.flash.text) : text)
  return `<div style="display:flex;flex-direction:column;gap:8px">
    <button class="btn-accent" data-action="send" ${agent ? '' : 'disabled'}${off ? ` title="${esc(off)}"` : ''}>${flash('send', 'Send failure to agent terminal')}</button>
    <button class="btn-outline" style="min-height:36px" data-action="copy">${flash('copy', 'Copy retry command')}</button>
    ${state.actionError ? `<div style="color:var(--fail);font-size:12px">${esc(state.actionError)}</div>` : ''}
    <div class="muted" style="font-size:11.5px;line-height:1.5">${
      off
        ? esc(off)
        : agent
        ? `Send types the failure into <b style="color:var(--text);font-weight:500">${esc(agent.title)}</b> in ${esc(agent.workspace)}, without pressing Enter.`
        : 'Open a terminal in this workspace to send the failure to an agent.'
    } Retry runs <span class="mono" style="overflow-wrap:anywhere">${esc(retryCommand(run, step.name))}</span>. The panel does not retry by itself.</div>
  </div>`
}

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
    ${parallel ? graph(run) : timeline(run, steps)}
    ${gates.length ? `<div style="margin-top:auto;display:flex;flex-direction:column;gap:12px">${gates.map((g) => gateCard(run, g)).join('')}</div>` : ''}
    ${failed ? failureActions(run, failed) : ''}
    ${runsOf(run)}
  </div>`
}

/** The run's workflow's latest runs, from the list the Workflows tab already read. */
function runsOf(run: Run): string {
  const runs = state.list.data?.workflows.find((w) => w.name === run.workflow)?.runs ?? []
  if (runs.length < 2) return ''
  const now = Date.now()
  return `<section class="section" style="gap:2px;margin-top:6px">
    <div class="label" style="margin-bottom:6px">RECENT RUNS</div>
    ${runs.map((r) => runRow(r, shortId(r.runId), now, run.id)).join('')}
  </section>`
}

function sectionTabs(): string {
  const f = state.factories.data
  const waiting = f?.installed ? f.factories.reduce((n, x) => n + x.needYou, 0) : 0
  const tab = (id: Place['tab'], label: string) => `<button role="tab" class="seg" aria-selected="${state.place.tab === id}" ${goTo(home(id))}>${label}</button>`
  return `<div role="tablist" class="segs">
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
  const line = (w: WorkItem, col: number) => `<button class="tline" data-action="seeStage" data-col="${col}" ${single ? '' : placeAttr(place(w))} style="color:${TICKET_COLOR[w.status]}">
      <span class="tlabel">${esc(TICKET_LABEL[w.status])} · </span><span class="when ellipsis">${esc(ticketWhen(w, now))}</span><span class="where ellipsis">${esc(w.stage)}</span><span class="off" aria-hidden="true">›</span>
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
  const runs = d.stages.find((s) => s.id === item.stage)?.workflow
  const pending = [...held.values()].flatMap((x) => x.gateIds.map((g) => ({ gate: g, exit: x })))
  const status = item.waiting
    ? `<div style="font-weight:600;color:var(--gold)">PERSON · waiting on ${esc(pending.map((p) => p.gate).join(', '))}</div>`
    : item.parked
      ? `<div style="font-weight:600;color:var(--warm)">PARKED · dispatch cap ${item.parked.count}/${item.parked.limit}, a person must grant an override</div>`
      : isFinished(item.status)
        ? `<div style="font-weight:600;color:var(--muted)">FINISHED · ${esc(item.stage)}</div>`
        : `<div style="font-weight:600;color:var(--muted)">AGENT · working in ${esc(item.stage)}</div>`
  const tab = (id: ItemTab, label: string) =>
    `<button role="tab" aria-selected="${state.itemTab === id}" class="tab" style="font-size:13px;padding:8px 12px" data-action="itemTab" data-tab="${id}">${label}</button>`
  const products = d.products.length
    ? `<section class="section" style="gap:6px"><div class="label">PRODUCTS</div>${d.products.map((p) => productRow(p, now)).join('')}</section>`
    : ''
  const now_ = `
    <div style="display:flex;flex-direction:column;gap:4px">
      <div class="muted" style="font-size:12px">In <span class="mono" style="color:var(--text)">${esc(item.stage)}</span>${runs ? ` · runs <span class="mono" style="color:var(--text)">${esc(runs)}</span>` : ''} · cycle ${item.cycle} · ${esc(since(item.enteredAt, now))}</div>
      ${status}
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
    <div class="section" style="gap:6px">${ticketGrid(d.stages, [item], now, true)}${LEGEND}</div>
    <div role="tablist" class="tabs">${tab('now', 'Now')}${tab('timeline', 'Timeline')}</div>
    ${state.itemTab === 'now' ? now_ : timeline}
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
  const skipped = n ? `<div class="stale">${n} ticket${n === 1 ? ' is' : 's are'} not shown: StageCraft wrote ${n === 1 ? 'it' : 'them'} in a format this panel does not read. Update the Swamp plugin or StageCraft so they match.</div>` : ''
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
  if (!res.data.repo) return header() + repoPicker(res.data.workspace ? 'No swamp repo for this workspace' : 'Swamp repos', res.data)
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

let drawn: string | undefined
function render(): void {
  savePlace()
  const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null
  const focused = focusKey(active)
  const caret = active?.id && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null
  const scrolled = new Map(Array.from(root.querySelectorAll<HTMLElement>('[data-keep-scroll]'), (el) => [el.dataset.keepScroll, [el.scrollTop, el.scrollLeft]]))
  const html = view()
  // The same page again is left alone, so a refresh does not drop the text a person selected in a log.
  if (html === drawn) return syncGrid()
  root.innerHTML = drawn = html
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

async function load<T>(key: 'resolution' | 'list' | 'run' | 'factories' | 'board' | 'item', fetch: () => Promise<T>): Promise<void> {
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

async function refreshFactories(dir: Repo): Promise<void> {
  state.factoriesAt = Date.now()
  await load('factories', () => orca.plugin.request('factories.list', { repo: dir }))
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

async function refresh(): Promise<void> {
  if (!themeSynced) syncTheme()
  const dir = repoDir()
  // While switching, the repo held is the last workspace's: asking it would only fetch what must not show.
  if (!dir || state.switching !== undefined) return render()
  const p = state.place
  if (p.tab === 'stagecraft') {
    await refreshFactories(dir)
    return render()
  }
  if (Date.now() - state.factoriesAt > BADGE_MS) void refreshFactories(dir).then(render)
  const list = () => load('list', () => orca.plugin.request('workflows.list', { repo: dir }))
  if (!('workflow' in p)) await list()
  else {
    // ponytail: the run screen reads the list once, for its recent runs; going back to the list reads it again.
    await Promise.all([
      load('run', () => orca.plugin.request('run.get', { repo: dir, workflow: p.workflow, ...(p.runId && { runId: p.runId }) })),
      state.list.data ? undefined : list()
    ])
    const run = state.run.data
    if (run) {
      if (state.selected === undefined && run.status === 'failed' && run.jobs.some((j) => j.stages.some((st) => st.length > 1))) {
        state.selected = firstFailed(run)?.name
      }
      if (run.status === 'failed' && state.agent === undefined && !remoteOff(dir, 'send')) {
        state.agent = await orca.plugin.request('agent.terminal', {}).catch(() => null)
      }
      await loadLogs(run)
    }
  }
  render()
}

// The repo each workspace showed when it was left, so switching to one known to share the current repo shows no loading screen.
const repoOfWorkspace = new Map<string, string>()
let repoAsk = 0

async function loadRepo(fetch: () => Promise<Resolution> = () => orca.plugin.request('repo.resolve', {})): Promise<void> {
  const ask = ++repoAsk
  generation++
  const prior = repoDir()
  const before = prior ? repoKey(prior) : placeRepo
  placeRepo = undefined
  await load('resolution', fetch)
  // A newer switch is under way; it settles the panel.
  if (ask !== repoAsk) return
  state.switching = undefined
  if (state.resolution.error) state.resolution = { error: state.resolution.error }
  const after = repoDir()
  // Another repo: nothing read from the last one may show, and its place does not apply.
  if (!after || repoKey(after) !== (prior ? repoKey(prior) : undefined)) {
    // Answers still on their way from the last repo are dropped.
    generation++
    Object.assign(state, { list: {}, run: {}, factories: {}, factoriesAt: 0, board: {}, item: {}, studio: { url: undefined, error: undefined } })
    if (before && before !== (after && repoKey(after))) state.place = home(state.place.tab)
  }
  await refresh()
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
  state.run = {}
  state.selected = undefined
  state.tab = 'logs'
  state.logs = { key: '', value: undefined, error: undefined }
  state.notes = {}
  state.actionError = undefined
  state.agent = undefined
  render()
  void refresh()
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

/** Runs a button's request; `fn` gets a check that is false once the person has moved to another screen. */
async function act(fn: (here: () => boolean) => Promise<void>): Promise<void> {
  const gen = generation
  const here = () => gen === generation
  state.busy = true
  state.actionError = undefined
  render()
  try {
    await fn(here)
  } catch (e) {
    if (here()) state.actionError = failure(e).message
  }
  state.busy = false
  render()
}

function pin(key: string): void {
  const choice = state.resolution.data?.candidates.find((c) => repoKey(c.repo) === key)
  if (choice) void loadRepo(() => orca.plugin.request('repo.pin', { repo: choice.repo }))
}

const actions: Record<string, (el: HTMLElement) => void> = {
  refresh: () => (repoDir() ? void refresh() : void loadRepo()),
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
      if (!here()) return
      state.run = { data }
      delete state.notes[step]
    })
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
  const items = Array.from(root.querySelectorAll<HTMLElement>('.theme-item'))
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
    render()
  } else if (el.dataset.input === 'note') state.notes[el.dataset.step ?? ''] = el.value
})
root.addEventListener('change', (e) => {
  const el = e.target as HTMLSelectElement
  if (el.dataset.change === 'pick') pin(el.value)
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
button:disabled { cursor: default; opacity: 0.6; }
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
.detail-head { padding: 10px 12px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; }
.tabs { display: flex; border-bottom: 1px solid var(--border); }
.tab { background: none; border: none; border-bottom: 2px solid transparent; color: var(--muted); padding: 7px 12px; font-size: 12px; }
.tab[aria-selected="true"] { border-bottom-color: var(--accent); color: var(--text); }
.log { margin: 0; padding: 10px 12px; font: 11.5px/1.6 var(--mono); color: var(--muted); white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto; }
.node { width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--raised); text-align: left; }
.node-col { flex-direction: column; align-items: stretch; gap: 4px; }
.parallel { width: 100%; display: grid; gap: 10px; }
.gate { border: 1px solid var(--gold); border-radius: 10px; padding: 14px; background: var(--gold-bg); display: flex; flex-direction: column; gap: 10px; }
.note { font-size: 13px; resize: none; padding: 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--deep); color: var(--text); }
.btn-gold { border-radius: 8px; border: none; background: var(--gold); color: var(--on-gold); font-weight: 600; }
.btn-outline { border-radius: 8px; border: 1px solid var(--border-strong); background: none; color: var(--text); }
.btn-outline:hover { background: var(--raised); }
.btn-accent { min-height: 38px; border-radius: 8px; border: none; background: var(--accent); color: var(--on-accent); font-weight: 600; }
.stale { margin: 0 16px; padding: 8px 10px; border-radius: 8px; font-size: 12px; color: var(--gold); background: var(--gold-bg); }
.segs { margin: 0 16px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); background: var(--raised); border-radius: 8px; padding: 3px; }
.seg { border: none; border-radius: 6px; padding: 7px; background: none; color: var(--muted); }
.seg[aria-selected="true"] { background: var(--panel); color: var(--text); font-weight: 500; }
.copy-row { display: flex; gap: 8px; align-items: center; padding: 8px 10px; border-radius: 8px; background: var(--deep); border: 1px solid var(--border); }
.copy-row code { flex: 1; min-width: 0; font-size: 11.5px; overflow-wrap: anywhere; }
.studio { min-height: 32px; padding: 0 10px; display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.fchip { padding: 5px 10px; border-radius: 14px; border: 1px solid var(--border); background: none; color: var(--muted); font-size: 12px; }
.fchip[aria-pressed="true"] { border-color: var(--c); color: var(--text); background: color-mix(in srgb, var(--c) 14%, var(--panel)); }
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
  if (state.place.tab === 'stagecraft') return IDLE_MS
  if ('workflow' in state.place) return state.run.data && isLive(state.run.data) ? LIVE_MS : IDLE_MS
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
    const current = repoDir()
    if (current) repoOfWorkspace.set(focused, repoKey(current))
    // Send types into a terminal of the focused workspace, so ask again which one.
    state.agent = undefined
    if (!current || repoOfWorkspace.get(key) !== repoKey(current)) {
      state.switching = context?.displayName ?? ''
      render()
    }
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
render()
syncTheme()
void loadRepo().finally(() => setTimeout(tick, nextDelay()))
