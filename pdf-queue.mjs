export class PdfQueueError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createPdfQueue({ concurrency = 2, maxWaiting = 8, waitMs = 30000, runMs = 90000 } = {}) {
  const waiting = [];
  let active = 0;

  function startNext() {
    while (active < concurrency && waiting.length) {
      const job = waiting.shift();
      job.stopWaiting();
      active++;
      void run(job);
    }
  }

  async function run({ task, signal, resolve, reject }) {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new PdfQueueError(504, 'PDF 생성 시간이 초과되었습니다.')), runMs);
    const execution = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    try {
      execution.throwIfAborted();
      const result = await task(execution);
      execution.throwIfAborted();
      resolve(result);
    } catch (error) {
      reject(execution.aborted ? execution.reason : error);
    } finally {
      clearTimeout(timer);
      active--;
      startNext();
    }
  }

  return function enqueue(task, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (active >= concurrency && waiting.length >= maxWaiting) {
      return Promise.reject(new PdfQueueError(503, 'PDF 대기열이 가득 찼습니다. 잠시 후 다시 시도해 주세요.'));
    }
    return new Promise((resolve, reject) => {
      const job = { task, signal, resolve, reject, stopWaiting };
      const timer = setTimeout(() => cancel(new PdfQueueError(503, 'PDF 대기 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.')), waitMs);
      function stopWaiting() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
      function cancel(error) {
        const index = waiting.indexOf(job);
        if (index < 0) return;
        waiting.splice(index, 1);
        stopWaiting();
        reject(error);
      }
      function abort() {
        cancel(signal.reason);
      }
      waiting.push(job);
      signal?.addEventListener('abort', abort, { once: true });
      startNext();
    });
  };
}
