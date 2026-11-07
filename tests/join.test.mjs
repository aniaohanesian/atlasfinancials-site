// Join waitlist: "You're on the list" shows the moment Join is tapped (Ania 2026-11-07: "Shouldnt we just say ur on the
// list once they click"); the save carries on in the background, and a failed save brings the form back with the error.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = new URL('..', import.meta.url).pathname;
// CHROME_PATH, else the browser already on frank-box, else Playwright's own (npx playwright-core install chromium)
const BOX_CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell`;
const CHROME = process.env.CHROME_PATH || (existsSync(BOX_CHROME) ? BOX_CHROME : undefined);
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.ico': 'image/x-icon' };
let server, browser, base;

before(async () => {
  server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    try { const body = await readFile(join(ROOT, path === '/' ? 'index.html' : path)); res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'text/html' }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ executablePath: CHROME });
});
after(async () => { await browser?.close(); server?.close(); });

async function joinWith(save) {
  const page = await browser.newPage({ viewport: { width: 375, height: 667 } });
  const sent = [];
  await page.route('https://script.google.com/**', async route => { sent.push(route.request().postData()); await save(route); });
  await page.goto(base);
  await page.fill('#hfEmail', 'someone@example.com');
  const request = page.waitForRequest('https://script.google.com/**');
  await page.click('#hfSubmit');
  await request;
  return { page, sent };
}
const shown = (page, sel) => page.$eval(sel, el => !el.hidden);
const until = (page, sel, hidden) => page.waitForFunction(([s, h]) => document.querySelector(s).hidden === h, [sel, hidden], { timeout: 2000 });

test('says "You\'re on the list" at once, while the save is still going', async () => {
  let finish; const saving = new Promise(r => { finish = r; });
  const { page, sent } = await joinWith(async route => { await saving; await route.fulfill({ status: 200, body: 'ok' }); });
  await until(page, '#hfDone', false); // throws if the thanks waits for the save
  assert.equal(sent.length, 1, 'the email was sent');
  assert.match(sent[0], /someone@example\.com/);
  assert.equal(await shown(page, '#hfDone'), true, 'thanks shows before the save finishes');
  assert.equal(await shown(page, '#hfAsk'), false);
  finish(); await page.waitForLoadState('networkidle');
  assert.equal(await shown(page, '#hfDone'), true, 'still thanked after the save');
  assert.equal(await shown(page, '#hfErr'), false);
  await page.close();
});

test('a failed save brings the form back with the error (control)', async () => {
  const { page } = await joinWith(route => route.abort());
  await until(page, '#hfErr', false);
  assert.equal(await shown(page, '#hfDone'), false, 'no thanks once the save failed');
  assert.equal(await shown(page, '#hfAsk'), true, 'the form is back');
  assert.equal(await shown(page, '#hfErr'), true, 'the error shows');
  assert.equal(await page.inputValue('#hfEmail'), 'someone@example.com', 'their email is kept');
  await page.close();
});

test('a late failure after "Add another person" leaves the next person alone and quietly tries again', async () => {
  let fail, retried; const failing = new Promise(r => { fail = r; }), retry = new Promise(r => { retried = r; });
  let calls = 0;
  const { page, sent } = await joinWith(async route => {
    if (++calls === 1) { await failing; await route.abort(); } else { retried(); await route.fulfill({ status: 200, body: 'ok' }); } });
  await page.click('#hfAgain');
  await page.fill('#hfEmail', 'next@example.com');
  fail(); await Promise.race([retry, new Promise((_, no) => setTimeout(() => no(new Error('the first email was never sent again')), 3000))]);
  assert.equal(sent.length, 2, 'the first email was sent again');
  assert.match(sent[1], /someone@example\.com/);
  assert.equal(await page.inputValue('#hfEmail'), 'next@example.com', 'what they typed is kept');
  assert.equal(await shown(page, '#hfAsk'), true, 'still on the form for the next person');
  assert.equal(await shown(page, '#hfErr'), false, 'no error about someone else');
  assert.equal(await shown(page, '#hfDone'), false);
  await page.close();
});
