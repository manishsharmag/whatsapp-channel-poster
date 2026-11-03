import test from 'node:test';
import assert from 'node:assert/strict';
import { formatNewsBulletin } from '../src/news.js';

test('formatNewsBulletin formats clean channel post with title, highlights, and link', () => {
  const article = {
    title: 'HSSC CET Advt 06/2026 Important Notice',
    highlights: [
      'Online applications open on 24.06.2026 and close on 30.06.2026',
      'Total marks: 100 with duration 1 Hour 45 Minutes',
    ],
    url: 'https://hssc.gov.in/notice/123',
  };

  const text = formatNewsBulletin(article);
  assert.ok(text.includes('📢 *Govt Job & Exam Alert*'));
  assert.ok(text.includes('📌 *HSSC CET Advt 06/2026 Important Notice*'));
  assert.ok(text.includes('• Online applications open on 24.06.2026 and close on 30.06.2026'));
  assert.ok(text.includes('🔗 *Official Link:* https://hssc.gov.in/notice/123'));
});
