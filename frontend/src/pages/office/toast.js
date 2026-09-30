// A small success / error toast for Office & Expenses, drawn with the app's own
// .toast-stack / .toast classes (styles.css). Imperative on purpose: the toast
// must outlive the modal that raised it (Add Vendor closes as it saves).
let stack = null;

function stackEl() {
  if (stack && document.body.contains(stack)) return stack;
  stack = document.createElement('div');
  stack.className = 'toast-stack oe-toasts';
  stack.setAttribute('role', 'status');
  stack.setAttribute('aria-live', 'polite');
  document.body.appendChild(stack);
  return stack;
}

export function showToast(message, tone = '', ms = 3500) {
  if (typeof document === 'undefined') return;
  const el = document.createElement('div');
  el.className = `toast${tone ? ` ${tone}` : ''}`;
  el.textContent = message;
  stackEl().appendChild(el);
  setTimeout(() => {
    el.remove();
    if (stack && !stack.childElementCount) { stack.remove(); stack = null; }
  }, ms);
}
