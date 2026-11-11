import type { Gate, InputField, LogText, RecentRun, Repo, Run, RunAction, RunId, WorkflowSummary } from './domain'
import type { Inbox } from './inbox'
import type { LogChunk } from './log'
import type { Resolution } from './repo'
import type { Board, Factories, WorkItemDetail } from './stagecraft'
import type { ThemeId } from './theme'

/** `runs` is every run of the repo, newest first, at most RUNS_LIMIT. */
export type ListData = { workflows: WorkflowSummary[]; gates: Gate[]; runs: RecentRun[]; version: string }
export type AgentTerminal = { id: string; title: string; workspace: string }

declare module 'orca' {
  interface PluginRequests {
    /**
     * The focused workspace's swamp repo (its pinned one first), or null with the repos the picker offers.
     * The worker remembers its slow lookups between asks; `fresh` reads them all again.
     */
    'repo.resolve': { input: { fresh?: boolean }; output: Resolution }
    /** Remembers `repo` as the focused workspace's repo and resolves again. */
    'repo.pin': { input: { repo: Repo }; output: Resolution }
    /** Each workflow with its run history, every gate waiting in the repo, every run, and the swamp version. */
    'workflows.list': { input: { repo: Repo }; output: ListData }
    /** One run; the latest when `runId` is omitted. */
    'run.get': { input: { repo: Repo; workflow: string; runId?: RunId }; output: Run }
    /** A run's log, narrowed to one model method when `logTag` is given, capped at 15 KiB. */
    'logs.get': { input: { repo: Repo; runId: RunId; logTag?: string }; output: LogText }
    /**
     * A run's log, read from its `.log` file: the lines after the byte offset `after`, the lines that end at
     * `before`, or with neither the newest. `limit` is the most bytes to read, clamped to 1 to 256 KiB.
     */
    'log.tail': { input: { repo: Repo; runId: RunId; after?: number; before?: number; limit?: number }; output: LogChunk }
    /** Approve or reject one gate and answer the refreshed run. Approve also starts `resume`. */
    'gate.decide': {
      input: { repo: Repo; workflow: string; runId: RunId; step: string; decision: 'approve' | 'reject'; note?: string }
      output: Run
    }
    /** The inputs the workflow declares, for the form Run shows; none for a workflow that takes no input. */
    'workflow.inputs': { input: { repo: Repo; workflow: string }; output: InputField[] }
    /**
     * Starts a run in the background: with the form's text for each input, or with the inputs of the run `again`.
     * Answers the new run's id once swamp lists it, or no id when it does not within 10 s.
     */
    'run.start': { input: { repo: Repo; workflow: string; inputs?: Record<string, string>; again?: RunId }; output: { runId?: RunId } }
    /**
     * Stops a run (`cancel`), retries a failed or suspended one (`resume`, from one step when `from` names it), or
     * recovers an interrupted one and resumes it. Answers the refreshed run; retry and recover wait up to 10 s for it to move.
     */
    'run.act': {
      input: { repo: Repo; workflow: string; runId: RunId; action: Exclude<RunAction, 'again'>; from?: { job: string; step: string } }
      output: Run
    }
    /** The focused workspace's terminal that "Send failure" types into: an agent's by title, else the first. */
    'agent.terminal': { input: Record<string, never>; output: AgentTerminal | null }
    /** Types the run's first failure, with log and retry commands, into that terminal without pressing Enter. */
    'failure.send': { input: { repo: Repo; workflow: string; runId: RunId }; output: AgentTerminal }
    /**
     * Every gate and StageCraft ticket that waits for a person, in every repo the worker knows: the repos of this
     * Mac's Orca workspaces, swamp's registry, the pinned repos and `repo`, the one the panel shows. One repo that
     * fails is named in `failed`. The answer is remembered for 30 s; `fresh` reads every repo again.
     */
    'inbox.list': { input: { fresh?: boolean; repo?: Repo }; output: Inbox }
    /** Whether the repo has StageCraft, and each factory with its latest tickets' statuses and how many need a person. */
    'factories.list': { input: { repo: Repo }; output: Factories }
    /** One factory's stages and every work item in it. */
    'factory.board': { input: { repo: Repo; factory: string }; output: Board }
    /** One work item: where it is, its exits and gates, products, journal and metrics. */
    'workitem.get': { input: { repo: Repo; key: string }; output: WorkItemDetail }
    /** Approve or decline one human-approval gate on the person's word. Approving the last gate an exit waits on also advances on it. */
    'workitem.decide': {
      input: { repo: Repo; key: string; gateId: string; decision: 'approve' | 'decline'; note?: string }
      output: WorkItemDetail & { advanced?: string; advanceError?: string }
    }
    /** The studio's URL, starting `studio serve` (and creating its model) on first use. */
    'studio.start': { input: { repo: Repo }; output: { url: string } }
    /** Copies text with pbcopy, for when the panel frame may not write the clipboard. */
    'clipboard.copy': { input: { text: string }; output: { copied: true } }
    /** Whether the "Needs you" tab is on, saved on this Mac; `on` sets it. */
    'inbox.enabled': { input: { on?: boolean }; output: { on: boolean } }
    /** The panel theme saved on this Mac; 'orca' follows Orca's own theme. */
    'theme.get': { input: Record<string, never>; output: { theme: ThemeId } }
    /** Saves the panel theme for every workspace. */
    'theme.set': { input: { theme: ThemeId }; output: { theme: ThemeId } }
  }
}
