const b = require('../src/bilibili.js');
(async () => {
  await b.ensureKeys();
  const cases = [
    'https://www.bilibili.com/video/BV1Tw411G74d/',
    'https://space.bilibili.com/3493093722556825/lists/947238',
    'https://space.bilibili.com/3493093722556825/'
  ];
  for (const c of cases) {
    try {
      const r = await b.resolveInput(c);
      console.log(c.slice(0, 62), '=> kind', r.kind, '| archives', (r.archives || []).length, '| seasons', (r.seasons || []).length,
        '| first', (r.archives || [])[0] && (r.archives[0].title || '').slice(0, 30));
    } catch (e) { console.log(c, 'ERR', e.message); }
  }
  try {
    const s = await b.searchVideos('孙燕姿 2000 我要的幸福');
    console.log('search =>', s.length, s[0] && s[0].title.slice(0, 40));
  } catch (e) { console.log('search ERR', e.message); }
  const t = b.parseTimestamps('On The Road(Demo1)00:00\n我要的幸福01:25\n坏天气05:01', 2630);
  console.log('parse =>', JSON.stringify(t));
})().catch(e => console.error(e));
