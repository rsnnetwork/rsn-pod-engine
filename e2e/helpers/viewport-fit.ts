import { expect, type Locator, type Page } from '@playwright/test';

// A control only counts as reachable if a person could press it right now,
// without scrolling anything: fully inside the window, and the topmost thing
// at its own centre (not clipped by an overflow-hidden ancestor, not covered).
//
// Why this exists (19 Sep 2026): "Confirm meeting" sat below the clip edge of
// the thread column on any window shorter than ~970px. toBeVisible() passed,
// because a clipped element is still "visible" to Playwright, and
// locator.click() passed too, because it scrolls clipped ancestors into view
// before clicking. Headed production runs stayed green while real people could
// not confirm a meeting. So: assert the box, then click by coordinates.

export interface ReachableBox { x: number; y: number; width: number; height: number; cx: number; cy: number }

export async function expectReachable(page: Page, target: Locator, label: string): Promise<ReachableBox> {
  await expect(target, `${label}: not in the page`).toHaveCount(1);
  const box = await target.boundingBox();
  expect(box, `${label}: not rendered`).not.toBeNull();
  const vp = page.viewportSize();
  expect(vp, 'a fixed viewport is required for a fit check').not.toBeNull();
  const b = box!;
  const right = Math.round(b.x + b.width);
  const bottom = Math.round(b.y + b.height);
  expect(Math.round(b.x), `${label}: left edge is off the window`).toBeGreaterThanOrEqual(0);
  expect(Math.round(b.y), `${label}: top edge is off the window`).toBeGreaterThanOrEqual(0);
  expect(right, `${label}: right edge ${right} is past the window width ${vp!.width}`).toBeLessThanOrEqual(vp!.width + 1);
  expect(bottom, `${label}: bottom edge ${bottom} is past the window height ${vp!.height}`).toBeLessThanOrEqual(vp!.height + 1);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const hit = await target.evaluate((el, p: { x: number; y: number }) => {
    const top = document.elementFromPoint(p.x, p.y);
    if (!top) return 'nothing';
    if (top === el || el.contains(top)) return 'self';
    const t = top as HTMLElement;
    return `${t.tagName.toLowerCase()}${t.id ? `#${t.id}` : ''}${t.className && typeof t.className === 'string' ? `.${t.className.split(' ').slice(0, 3).join('.')}` : ''}`;
  }, { x: cx, y: cy });
  expect(hit, `${label}: its centre is clipped or covered`).toBe('self');
  return { ...b, cx, cy };
}

/** Press where a finger would land. Never locator.click(): it scrolls for you. */
export async function tapReachable(page: Page, target: Locator, label: string): Promise<void> {
  const { cx, cy } = await expectReachable(page, target, label);
  await page.mouse.click(cx, cy);
}
