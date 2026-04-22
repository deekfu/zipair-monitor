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
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // Step 1 — visit homepage for Cloudflare clearance
    console.log('Step 1: Loading homepage...');
    await page.goto('https://www.zipair.net/en', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });
    await new Promise(r => setTimeout(r, 5000));

    // Step 2 — visit search page to collect session cookies
    console.log('Step 2: Loading search page...');
    await page.goto(
      'https://www.zipair.net/en/flight/search?origin=LAX&destination=NRT&adult=3&childA=0&childB=0&childC=0&infant=0',
      { waitUntil: 'networkidle2', timeout: 60000 }
    );
    await new Promise(r => setTimeout(r, 5000));

    // Step 3 — extract cookies and use them to call the BFF API directly
    console.log('Step 3: Extracting cookies...');
    const cookies = await page.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    console.log(`Got ${cookies.length} cookies`);

    await browser.close();
    browser = null;

    // Step 4 — fetch the calendar API with real session cookies
    console.log('Step 4: Calling calendar API...');
    const url = 'https://bff.zipair.net/v1/flights/calendar?adult=3&childA=0&childB=0&childC=0&infant=0&routes=LAX%2CNRT&currency=USD&language=en&departureDateFrom=2026-11-01&departureDateTo=2026-11-30';

    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://www.zipair.net',
        'Referer': 'https://www.zipair.net/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Cookie': cookieHeader,
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} — ${res.statusText}`);
    }

    const calendarData = await res.json();
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
