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

    // Step 1 — visit homepage to get Cloudflare clearance
    const page = await browser.newPage();
    await page.goto('https://www.zipair.net/en', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });
    await new Promise(r => setTimeout(r, 5000));

    // Step 2 — visit search page to set all cookies
    await page.goto(
      'https://www.zipair.net/en/flight/search?origin=LAX&destination=NRT&adult=3&childA=0&childB=0&childC=0&infant=0',
      { waitUntil: 'networkidle2', timeout: 60000 }
    );
    await new Promise(r => setTimeout(r, 8000));

    // Step 3 — open the API URL directly in a new browser tab
    const apiPage = await browser.newPage();
    await apiPage.goto(
      'https://bff.zipair.net/v1/flights/calendar?adult=3&childA=0&childB=0&childC=0&infant=0&routes=LAX%2CNRT&currency=USD&language=en&departureDateFrom=2026-11-01&departureDateTo=2026-11-30',
      { waitUntil: 'networkidle2', timeout: 60000 }
    );

    // Step 4 — grab the JSON response from the page body
    const content = await apiPage.evaluate(() => document.body.innerText);
    console.log('Raw API response (first 200 chars):', content.substring(0, 200));
    const calendarData = JSON.parse(content);

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

schedule.scheduleJob('0 */4 * * *', checkZipair); // every 4 hours

console.log('✅ Zipair monitor running. Scheduled every 4 hours.');
console.log('   Running first check now...\n');

checkZipair();
