/*
 * Ribbon command entry point. The manifest references this file via
 * <FunctionFile>; Office requires it even when all commands open the task pane.
 */
Office.onReady(() => {});

// Example UI-less command handler, kept for future ribbon buttons.
function noop(event) {
  event.completed();
}

// Register so Office can invoke it by name from the manifest if needed.
if (typeof Office !== "undefined") {
  Office.actions?.associate?.("noop", noop);
}
