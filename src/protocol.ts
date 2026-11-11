import type { Gate, LogText, RecentRun, Repo, Run, RunId, WorkflowSummary } from './domain'
import type { Resolution } from './repo'
import type { Board, Factories, WorkItemDetail } from './stagecraft'
import type { ThemeId } from './theme'

export type ListData = { workflows: WorkflowSummary[]; gates: Gate[]; recent: RecentRun[]; version: string }
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
    /** Each workflow with its run history, every gate waiting in the repo, the newest runs, and the swamp version. */
    'workflows.list': { input: { repo: Repo }; output: ListData }
    /** One run; the latest when `runId` is omitted. */
    'run.get': { input: { repo: Repo; workflow: string; runId?: RunId }; output: Run }
    /** A run's log, narrowed to one model method when `logTag` is given, capped at 15 KiB. */
    'logs.get': { input: { repo: Repo; runId: RunId; logTag?: string }; output: LogText }
    /** Approve or reject one gate and answer the refreshed run. Approve also starts `resume`. */
    'gate.decide': {
      input: { repo: Repo; workflow: string; runId: RunId; step: string; decision: 'approve' | 'reject'; note?: string }
      output: Run
    }
    /** The focused workspace's terminal that "Send failure" types into: an agent's by title, else the first. */
    'agent.terminal': { input: Record<string, never>; output: AgentTerminal | null }
    /** Types the run's first failure, with log and retry commands, into that terminal without pressing Enter. */
    'failure.send': { input: { repo: Repo; workflow: string; runId: RunId }; output: AgentTerminal }
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
    /** The panel theme saved on this Mac; 'orca' follows Orca's own theme. */
    'theme.get': { input: Record<string, never>; output: { theme: ThemeId } }
    /** Saves the panel theme for every workspace. */
    'theme.set': { input: { theme: ThemeId }; output: { theme: ThemeId } }
  }
}
