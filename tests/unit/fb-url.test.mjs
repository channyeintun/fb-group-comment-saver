import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalCommentUrl,
  canonicalPostUrl,
  canonicalProfileUrl,
  classifyTabUrl,
  isFacebookHost,
  linkTargetHost,
  parseFbUrl,
  stripTracking,
} from '../../src/lib/fb-url.js';

const G = 'myanmarsoftwareengineers';

describe('parseFbUrl', () => {
  test('reply permalink with tracking params', () => {
    const href = `https://www.facebook.com/groups/${G}/posts/1234567890123456/?comment_id=1111&reply_comment_id=2222&__cft__[0]=AZWx-yz&__tn__=R]-R`;
    assert.deepEqual(parseFbUrl(href), {
      host: 'www.facebook.com',
      groupSlug: G,
      postId: '1234567890123456',
      commentId: '1111',
      replyCommentId: '2222',
      userId: null,
      vanity: null,
    });
  });

  test('/permalink/ form and web.facebook.com', () => {
    const p = parseFbUrl(`https://web.facebook.com/groups/${G}/permalink/987654321/`);
    assert.equal(p.host, 'web.facebook.com');
    assert.equal(p.groupSlug, G);
    assert.equal(p.postId, '987654321');
    assert.equal(p.commentId, null);
  });

  test('pfbid-style post ids', () => {
    assert.equal(parseFbUrl('https://www.facebook.com/groups/abc/posts/pfbid02AbC.d-e/').postId, 'pfbid02AbC.d-e');
  });

  test('post id from multi_permalinks or story_fbid', () => {
    assert.equal(parseFbUrl(`https://www.facebook.com/groups/${G}/?multi_permalinks=555,666`).postId, '555');
    assert.equal(parseFbUrl(`https://www.facebook.com/groups/${G}/?multi_permalinks=555`).groupSlug, G);
    const sf = parseFbUrl('https://www.facebook.com/permalink.php?story_fbid=777&id=123');
    assert.equal(sf.postId, '777');
    assert.equal(sf.groupSlug, null);
  });

  test('user ids: group member path, /user/, profile.php', () => {
    assert.equal(parseFbUrl(`https://www.facebook.com/groups/${G}/user/100012345678901/?__cft__[0]=x`).userId, '100012345678901');
    assert.equal(parseFbUrl(`https://www.facebook.com/groups/${G}/user/100012345678901/`).groupSlug, G);
    assert.equal(parseFbUrl('https://www.facebook.com/user/42').userId, '42');
    const pp = parseFbUrl('https://www.facebook.com/profile.php?id=100004444444444&__tn__=R');
    assert.equal(pp.userId, '100004444444444');
    assert.equal(pp.vanity, null);
  });

  test('vanity names', () => {
    assert.equal(parseFbUrl('https://www.facebook.com/htoo.htet.aung').vanity, 'htoo.htet.aung');
    assert.equal(parseFbUrl('https://www.facebook.com/htoo.htet.aung/?__tn__=R').vanity, 'htoo.htet.aung');
    for (const reserved of ['groups', 'profile.php', 'photo', 'photos', 'watch', 'events', 'hashtag', 'l.php', 'story.php', 'permalink.php', 'pages', 'people', 'reel', 'share']) {
      assert.equal(parseFbUrl(`https://www.facebook.com/${reserved}`).vanity, null, reserved);
    }
    assert.equal(parseFbUrl('https://www.facebook.com/a/b').vanity, null); // not top-level
    assert.equal(parseFbUrl('https://example.com/someone').vanity, null); // not facebook
  });

  test('relative hrefs resolve against www.facebook.com or the given base', () => {
    const rel = parseFbUrl(`/groups/${G}/posts/42/?comment_id=7`);
    assert.equal(rel.host, 'www.facebook.com');
    assert.equal(rel.postId, '42');
    assert.equal(rel.commentId, '7');
    assert.equal(parseFbUrl('/groups/x/posts/1/', 'https://web.facebook.com/').host, 'web.facebook.com');
  });

  test('null / garbage input gives all-null result', () => {
    const empty = { host: null, groupSlug: null, postId: null, commentId: null, replyCommentId: null, userId: null, vanity: null };
    assert.deepEqual(parseFbUrl(null), empty);
    assert.deepEqual(parseFbUrl(''), empty);
    assert.deepEqual(parseFbUrl('http://[bad'), empty);
  });
});

describe('isFacebookHost', () => {
  test('desktop hosts only', () => {
    assert.equal(isFacebookHost('facebook.com'), true);
    assert.equal(isFacebookHost('www.facebook.com'), true);
    assert.equal(isFacebookHost('web.facebook.com'), true);
    assert.equal(isFacebookHost('WWW.Facebook.com'), true);
    assert.equal(isFacebookHost('m.facebook.com'), false);
    assert.equal(isFacebookHost('mbasic.facebook.com'), false);
    assert.equal(isFacebookHost('l.facebook.com'), false);
    assert.equal(isFacebookHost('evilfacebook.com'), false);
    assert.equal(isFacebookHost('facebook.com.evil.net'), false);
    assert.equal(isFacebookHost(''), false);
    assert.equal(isFacebookHost(undefined), false);
  });
});

describe('canonical URLs', () => {
  test('canonicalPostUrl', () => {
    assert.equal(canonicalPostUrl(G, '123'), `https://www.facebook.com/groups/${G}/posts/123/`);
  });

  test('canonicalCommentUrl with and without reply id', () => {
    assert.equal(canonicalCommentUrl(G, '123', '456'), `https://www.facebook.com/groups/${G}/posts/123/?comment_id=456`);
    assert.equal(
      canonicalCommentUrl(G, '123', '456', '789'),
      `https://www.facebook.com/groups/${G}/posts/123/?comment_id=456&reply_comment_id=789`,
    );
    assert.equal(canonicalCommentUrl(G, '123', '456', null), `https://www.facebook.com/groups/${G}/posts/123/?comment_id=456`);
  });

  test('canonicalProfileUrl', () => {
    assert.equal(canonicalProfileUrl({ userId: '100', vanity: 'x' }), 'https://www.facebook.com/profile.php?id=100');
    assert.equal(canonicalProfileUrl({ userId: null, vanity: 'htoo.htet' }), 'https://www.facebook.com/htoo.htet');
    assert.equal(canonicalProfileUrl({ userId: null, vanity: null }), null);
    assert.equal(canonicalProfileUrl(null), null);
  });
});

describe('stripTracking', () => {
  test('removes __cft__*, __tn__, ref, notif_*, eid; keeps other params', () => {
    const href = `https://www.facebook.com/groups/${G}/posts/1/?comment_id=2&__cft__[0]=AZ&__cft__[1]=B&__tn__=R]-R&ref=notif&notif_id=9&notif_t=x&eid=E&reply_comment_id=3`;
    assert.equal(stripTracking(href), `https://www.facebook.com/groups/${G}/posts/1/?comment_id=2&reply_comment_id=3`);
  });

  test('drops the "?" when nothing is left', () => {
    assert.equal(stripTracking(`https://www.facebook.com/groups/${G}/user/5/?__cft__[0]=AZ&__tn__=-R`), `https://www.facebook.com/groups/${G}/user/5/`);
  });

  test('URLs without params are unchanged; relative hrefs become absolute', () => {
    assert.equal(stripTracking('https://www.facebook.com/x/'), 'https://www.facebook.com/x/');
    assert.equal(stripTracking('/groups/x/posts/1/?__tn__=R'), 'https://www.facebook.com/groups/x/posts/1/');
  });

  test('external links keep generic params like ref but lose fbclid', () => {
    assert.equal(
      stripTracking('https://example.com/a?ref=main&fbclid=IwAR123&q=1'),
      'https://example.com/a?ref=main&q=1',
    );
  });

  test('null and non-http input pass through', () => {
    assert.equal(stripTracking(null), null);
    assert.equal(stripTracking(undefined), null);
    assert.equal(stripTracking('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  });
});

describe('classifyTabUrl', () => {
  test('post URLs', () => {
    assert.deepEqual(classifyTabUrl(`https://www.facebook.com/groups/${G}/posts/123/`), { kind: 'post', groupSlug: G, postId: '123' });
    assert.deepEqual(classifyTabUrl(`https://web.facebook.com/groups/${G}/permalink/456/?comment_id=1`), { kind: 'post', groupSlug: G, postId: '456' });
  });

  test('group URLs (any subpath except posts/permalink)', () => {
    for (const url of [
      `https://www.facebook.com/groups/${G}`,
      `https://www.facebook.com/groups/${G}/`,
      `https://www.facebook.com/groups/${G}/?sorting_setting=CHRONOLOGICAL`,
      `https://www.facebook.com/groups/${G}/discussion`,
      `https://facebook.com/groups/${G}/members/`,
    ]) {
      assert.deepEqual(classifyTabUrl(url), { kind: 'group', groupSlug: G, postId: null }, url);
    }
  });

  test('other Facebook pages', () => {
    for (const url of ['https://www.facebook.com/', 'https://www.facebook.com/groups/feed/', 'https://www.facebook.com/someone', 'https://web.facebook.com/watch']) {
      assert.deepEqual(classifyTabUrl(url), { kind: 'facebook', groupSlug: null, postId: null }, url);
    }
  });

  test('mobile sites', () => {
    assert.equal(classifyTabUrl(`https://m.facebook.com/groups/${G}/posts/1/`).kind, 'mobile');
    assert.equal(classifyTabUrl('https://mbasic.facebook.com/').kind, 'mobile');
  });

  test('non-Facebook and invalid', () => {
    assert.deepEqual(classifyTabUrl('https://example.com/groups/x/posts/1/'), { kind: 'other', groupSlug: null, postId: null });
    assert.equal(classifyTabUrl('chrome://extensions').kind, 'other');
    assert.equal(classifyTabUrl('').kind, 'other');
    assert.equal(classifyTabUrl(undefined).kind, 'other');
  });
});

describe('linkTargetHost', () => {
  test('decodes the l.php target', () => {
    const target = 'https://example.com/path?q=1&x=မြန်မာ';
    assert.equal(linkTargetHost(`https://l.facebook.com/l.php?u=${encodeURIComponent(target)}&h=AT0abc`), target);
    assert.equal(linkTargetHost(`https://lm.facebook.com/l.php?u=${encodeURIComponent('https://a.b/')}`), 'https://a.b/');
  });

  test('null for non-shim links', () => {
    assert.equal(linkTargetHost('https://example.com/l.php?u=https%3A%2F%2Fx.y'), null);
    assert.equal(linkTargetHost('https://l.facebook.com/other?u=x'), null);
    assert.equal(linkTargetHost('https://l.facebook.com/l.php'), null);
    assert.equal(linkTargetHost(null), null);
  });
});
