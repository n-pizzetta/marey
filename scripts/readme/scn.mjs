const btn = (p, re) => p.locator("button, [role=tab]").filter({ hasText: re }).first();
/** A session view tab: the sessions list behind it has buttons with the same names. */
const tab = (p, re) => p.locator(".tabs .tab").filter({ hasText: re }).first();
const sess = (p, t) => p.getByText(t, { exact: false }).first();
const nav = (p, re) => p.locator(".app-header button, header button").filter({ hasText: re }).first();
/** Native selects open outside the page, so the recording would show nothing: point at it, then pick. */
async function pickShow(p, moveTo, wait, value) {
  const sel = p.locator(".scope-select").filter({ hasText: "Show" }).locator("select");
  await moveTo(sel); await wait(500);
  await sel.selectOption(value); await wait(1100);
}
export default {
  async replay({ p, wait, click, moveTo }) {
    await click(nav(p, /^Sessions/), 1200);
    await click(p.getByPlaceholder(/Search goals/), 400);
    await p.keyboard.type("layout shift", { delay: 90 }); await wait(900);
    await click(p.locator(".st-row").filter({ hasText: "Fix layout shift on the settings page" }).first(), 1600);
    await moveTo(p.getByText(/^Prompts/).first(), 170, 200); await wait(1200);
    await click(tab(p, /^Tools/), 1300);
    await p.mouse.wheel(0, 380); await wait(1200);
    await p.mouse.wheel(0, -380); await wait(300);
    await click(tab(p, /^Tokens/), 2200);
  },
  async timeline({ p, wait, click, glide }) {
    // A demo session long enough to compact once.
    const id = await p.evaluate(async () => (await (await fetch("/api/sessions")).json()).sessions.find((s) => JSON.stringify(s).includes("Fix the flaky integration test in orders/checkout")).id);
    await p.evaluate((id) => { location.hash = `#session/${id}`; }, id); await wait(1400);
    await click(tab(p, /^Timeline/), 1400);
    for (let x = 140; x <= 1320; x += 90) { await glide(x, 560); await wait(140); }
    await wait(800);
  },
  async live({ p, wait, click, moveTo }) {
    // Now: point at the slices of Claude Code's 5h bar, then at the running sessions they stand for.
    const segs = p.locator(".plan-card").first().locator(".plan-bar-seg");
    const n = Math.min(await segs.count(), 3);
    for (let i = 0; i < n; i++) { await moveTo(segs.nth(i)); await wait(1100); }
    await moveTo(p.locator(".board-row").filter({ hasText: "docs-site" }).first(), -300, 0); await wait(1300);
    await moveTo(p.locator(".board-row").filter({ hasText: "acme-api" }).first(), -300, 0); await wait(1300);
    await click(p.locator(".board-row").filter({ hasText: "web-dashboard" }).first(), 1400);
    // The verdict opens its reasons; the context and cache figures beside it keep moving.
    await click(p.locator(".status-verdict-label").first(), 3200);
    await moveTo(p.locator(".status-verdict-label").first(), -260, 0); await wait(2500);
  },
  async fleet({ p, wait, click, moveTo }) {
    await click(nav(p, /^Usage/), 1500);
    await moveTo(p.getByText("Fix broken links reported by the link checker").first()); await wait(1300);
    await p.mouse.wheel(0, 900); await wait(1500);
    await click(btn(p, /^30d$/), 1500);
    await p.mouse.wheel(0, 700); await wait(1600);
    await click(nav(p, /^Health/), 1700);
    await p.mouse.wheel(0, 1200); await wait(1800);
  },
  async compare({ p, wait, click, moveTo }) {
    await click(nav(p, /^Sessions/), 1200);
    await pickShow(p, moveTo, wait, "failed");
    await click(btn(p, /^Compare$/), 800);
    const rows = p.locator(".st-row");
    for (const i of [0, 1, 3]) await click(rows.nth(i), 800);
    await moveTo(p.getByText("Compare").first(), 300, 200); await wait(3000);
  },
  async ghost({ p, wait, click, moveTo }) {
    await click(nav(p, /^Sessions/), 1200);
    await pickShow(p, moveTo, wait, "ghost");
    await click(sess(p, "Bump the React Native version"), 1500);
    await click(p.locator(".ghost-chip").first(), 1200);
    const del = p.locator(".ghost-banner button").filter({ hasText: /delete/i }).first();
    if (await del.count()) { await moveTo(del); await wait(2000); }
    await wait(600);
  },
};
