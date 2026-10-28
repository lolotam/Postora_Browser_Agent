// Playwright can retain its terminated Worker object after stopAllWorkers.
// Resolve the live Chromium target for each test-only instrumentation call.
// No evaluation or application request is replayed if it fails.
export function extensionWorker(context, panel, extensionId) {
  return {
    async evaluate(fn, argument) {
      const cdp = await context.newCDPSession(panel);
      let sessionId;
      let timer;
      let receive;
      try {
        const { targetInfos } = await cdp.send('Target.getTargets');
        const target = targetInfos.find((item) => item.type === 'service_worker'
          && item.url.startsWith(`chrome-extension://${extensionId}/`));
        if (!target) throw new Error('No live extension service-worker target');
        ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false }));
        const response = new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Extension worker evaluation timed out')), 30000);
          receive = (event) => {
            if (event.sessionId !== sessionId) return;
            const message = JSON.parse(event.message);
            if (message.id !== 1) return;
            if (message.error) reject(new Error(message.error.message));
            else resolve(message.result);
          };
          cdp.on('Target.receivedMessageFromTarget', receive);
        });
        // Register both promises before awaiting so a send failure cannot leave
        // the response promise's rejection unobserved during teardown.
        const [, result] = await Promise.all([
          cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({
            id: 1, method: 'Runtime.evaluate', params: {
              expression: `(${fn.toString()})(${argument === undefined ? 'undefined' : JSON.stringify(argument)})`,
              awaitPromise: true, returnByValue: true,
            },
          }) }),
          response,
        ]);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        return result.result.value;
      } finally {
        clearTimeout(timer);
        if (receive) cdp.off('Target.receivedMessageFromTarget', receive);
        if (sessionId) await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
        await cdp.detach();
      }
    },
  };
}
