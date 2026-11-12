// client/src/lib/copy-text.ts
// Copy a line of text (a link) to the clipboard. The Clipboard API needs a secure page and, on older iPhones, is
// missing or refuses outside a tap; the old way (a selected, off-screen text box and the copy command) covers those.
// Resolves to whether it was copied, so the screen can say so or show the text to copy by hand.

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused (no permission, not a secure page): the old way below may still work.
  }
  return copyWithSelection(text);
}

function copyWithSelection(text: string): boolean {
  const box = document.createElement('textarea');
  box.value = text;
  box.setAttribute('readonly', '');
  // Off screen, and at 16px so iOS does not zoom the page to it.
  box.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;font-size:16px;';
  document.body.appendChild(box);
  try {
    box.select();
    box.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    box.remove();
  }
}
