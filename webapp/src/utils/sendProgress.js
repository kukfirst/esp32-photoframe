// The "Sending N / M" line, as a pure function so its arithmetic is testable.
//
// PHOTOFRAME-002 (2026-11-14). The label used to be `done + 1 / total` in the
// template: it counted the photo *in flight* by adding one to the number already
// finished. That is fine in the middle of a batch, but the moment the last photo
// finished it read **26 / 25** — and anything that kept the send open after that
// (a post-send refresh that never returned, a helper service that stopped
// answering) left it there, so a completed batch looked like an upload that would
// never end. The numbers are now derived from the counts instead of incremented
// in the template, and the finished state says so in words.

export function progressLabel(done, total) {
  const d = Math.max(0, Math.min(done, total));
  if (total <= 0) {
    return "Nothing to send";
  }
  if (d >= total) {
    return `Sent ${total} of ${total}`;
  }
  return `Sending ${d + 1} of ${total}`;
}

export function progressPercent(done, total) {
  if (total <= 0) {
    return 0;
  }
  return (Math.max(0, Math.min(done, total)) / total) * 100;
}

// What to tell the owner when a send stopped before the queue was empty.
// "left" is what is still waiting, "failed" what the frame refused.
export function sendOutcome({ sent = 0, failed = 0, left = 0, asleep = false }) {
  const parts = [];
  if (sent) {
    parts.push(`${sent} sent`);
  }
  if (failed) {
    parts.push(`${failed} failed`);
  }
  if (asleep) {
    return {
      level: "warning",
      text: `The frame fell asleep: ${parts.join(", ") || "nothing sent"}. ${left} left — press Refresh, then Send again; the photos already on the frame will not be sent twice.`,
    };
  }
  if (failed) {
    return {
      level: "warning",
      text: `Stopped with ${parts.join(", ")}. The red ones stay in the list — Send again retries only those.`,
    };
  }
  return null;
}
