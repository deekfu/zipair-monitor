import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import schedule from 'node-schedule';
import 'dotenv/config';

puppeteer.use(StealthPlugin());

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

    // Set a realistic viewport and user agent
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // Intercept the calendar API response as the page loads it naturally
    let calendarData = null;
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('bff.zipair.net/v1/flights/calendar')) {
        try {
          const json = await response.json();
          calendarData = json;
          console.log('Intercepted calendar API response ✅');
        } catch (e) {
          console.log('Failed to parse intercepted response:', e.message);
        }
      }
    });

    // Step 1 — visit homepage for Cloudflare clearance
    console.log('Step 1: Loading homepage...');
    await page.goto('https://www.zipair.net/en', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });
    await new Promise(r => setTimeout(r, 5000));

    // Step 2 — navigate to search page (this triggers the calendar API call)
    console.log('Step 2: Loading search page...');
    await page.goto(
      'https://www.zipair.net/en/flight/search?origin=LAX&destination=NRT&adult=3&childA=0&childB=0&childC=0&infant=0',
      { waitUntil: 'networkidle2', timeout: 60000 }
    );

    // Wait up to 15s for the intercepted API response to arrive
    const maxWait = 15000;
    const interval = 500;
    let waited = 0;
    while (!calendarData && waited < maxWait) {
      await new Promise(r => setTimeout(r, interval));
      waited += interval;
    }

    await browser.close();
    browser = null;

    if (!calendarData) {
      throw new Error('Calendar API response was never intercepted — page may not have triggered it');
    }

    console.log('Raw API response (first 200 chars):', JSON.stringify(calendarData).substring(0, 200));
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
        `Will keep checking every 4 hours.`
      );
    }

  } catch (err) {
    if (browser) await browser.close();
    console.error('Error:', err.message);
    await sendPush(`⚠️ Zipair monitor error at ${now}.\n\n${err.message}`);
  }
}

schedule.scheduleJob('0 */4 * * *', checkZipair); // every 4 hours
console.log('✅ Zipair monitor running. Scheduled every 4 hours.');
console.log('   Running first check now...\n');
checkZipair();
