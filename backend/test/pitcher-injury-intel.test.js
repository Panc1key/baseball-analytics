import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGoogleNewsRss } from '../src/services/PitcherNewsSearchService.js';

test('Google News RSS 解析出標題與連結', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item>
      <title><![CDATA[Pitcher returns from elbow surgery]]></title>
      <link>https://example.com/a</link>
      <pubDate>Mon, 20 Jul 2026 10:00:00 GMT</pubDate>
      <description><![CDATA[<p>He is on a workload plan after UCL surgery.</p>]]></description>
    </item>
    <item>
      <title>Healthy starter locked in</title>
      <link>https://example.com/b</link>
      <description>No injury concerns.</description>
    </item>
  </channel></rss>`;
  const items = parseGoogleNewsRss(xml, { limit: 5 });
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Pitcher returns from elbow surgery');
  assert.equal(items[0].url, 'https://example.com/a');
  assert.match(items[0].snippet, /workload plan/i);
});
