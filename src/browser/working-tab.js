// The tab a task works on is gone. It was closed by the user, by the site, or
// by the agent itself. The task cannot go on: it would act on a page nobody
// chose for it, so this error ends the task instead of the step.
//
// The code is the stable name of the failure: the panel translates it, and the
// message is the fallback for a reader that does not know the code.

/** The stable name of the loss of the working tab. */
export const WORKING_TAB_CLOSED = 'working-tab-closed';

/** The tab the task works on is gone: the task ends here. */
export class WorkingTabClosedError extends Error {
  constructor(tabId = null) {
    super(tabId == null
      ? 'The tab this task was working on was closed.'
      : `The tab this task was working on (${tabId}) was closed.`);
    this.name = 'WorkingTabClosedError';
    this.code = WORKING_TAB_CLOSED;
    this.tabId = tabId;
  }
}

/** Whether the error is the loss of the working tab, whatever wrapped it. */
export function isWorkingTabClosed(error) {
  return error?.name === 'WorkingTabClosedError' || error?.code === WORKING_TAB_CLOSED;
}
