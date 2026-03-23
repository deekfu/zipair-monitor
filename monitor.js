import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import schedule from 'node-schedule';
import 'dotenv/config';

puppeteer.use(StealthPlugin());

// ─── Pushover ─────────────────────────────────────────────────────────────────

async function sendPush(message) {
  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: process.env.PUSHOVER_API_TOKEN,
      user:  process.env.PUSHOVER_USER_KEY,
      message,
    }),
  });
  const data = await res.json();
  if (data.status === 1) {
    console.log('Notification sent!');
  } else {
    console.error('Pushover error:', JSON.stringify(data));
  }
}

// ─── Main Check ───────────────────────────────────────────────────────────────

async function checkZipair() {
  const now = new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  console.log(`[${now}] Checking Zipair...`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1280,800',
      ],
    });

    const page = await browser.newPage();

    await page.goto(
      'https://www.zipair.net/en/flight/search?origin=LAX&destination=NRT&adult=3&childA=0&childB=0&childC=0&infant=0',
      { waitUntil: 'networkidle2', timeout: 60000 }
    );

    // Wait extra time for Zipair JS to execute and set cookies
    await new Promise(r => setTimeout(r, 8000));

    // Scroll to trigger any lazy-loaded content
    await page.evaluate(() => window.scrollBy(0, 500));
    await new Promise(r => setTimeout(r, 3000));

    const cookies = await page.cookies();
    console.log('Cookies found:', cookies.map(c => c.name).join(', '));
    const tokenCookie = cookies.find(c => c.name === 'zipair_token');
    const authToken = tokenCookie?.value;

    if (!authToken) {
      throw new Error('Could not find zipair_token in cookies.');
    }

    const calendarData = await page.evaluate(async (token) => {
      const res = await fetch(
        'https://bff.zipair.net/v1/flights/calendar?adult=3&childA=0&childB=0&childC=0&infant=0&routes=LAX%2CNRT&currency=USD&language=en&departureDateFrom=2026-11-01&departureDateTo=2026-11-30',
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'accept': 'application/json',
            'origin': 'https://www.zipair.net',
            'referer': 'https://www.zipair.net/',
          }
        }
      );
      return res.json();
    }, authToken);

    await browser.close();
    browser = null;

    console.log('Total dates returned:', calendarData.data.length);

    const available = calendarData.data.filter(d =>
      d.departureDate?.startsWith('2026-11') && d.price != null
    );

    if (available.length > 0) {
      const dateList = available
        .map(d => `  ${d.departureDate}: $${d.price}`)
        .join('\n');

      await sendPush(
        `🚨 ZIPAIR ALERT — November tickets LIVE!\n\n` +
        `${available.length} date(s) available:\n${dateList}\n\n` +
        `Book NOW → zipair.net\n📅 Checked: ${now}`
      );

    } else {
      await sendPush(
        `✅ Zipair checked — no November availability yet.\n\n` +
        `📅 ${now}\n🛫 LAX → TYO (3 adults)\n\n` +
        `Will check again at next scheduled time.`
      );
    }

  } catch (err) {
    if (browser) await browser.close();
    console.error('Error:', err.message);
    await sendPush(`⚠️ Zipair monitor error at ${now}.\n\n${err.message}`);
  }
}

// ─── Schedule: 8am and 8pm Pacific ───────────────────────────────────────────

schedule.scheduleJob('0 8  * * *', checkZipair); // 8:00 AM
schedule.scheduleJob('0 20 * * *', checkZipair); // 8:00 PM

console.log('✅ Zipair monitor running. Scheduled 8am + 8pm Pacific.');
console.log('   Running first check now...\n');

checkZipair();
