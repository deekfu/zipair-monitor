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
    let calendarData = null;

    // Intercept calendar API as the page calls it naturally
    page.on('response', async (response) => {
      if (response.url().includes('bff.zipair.net/v1/flights')) {
        console.log('API call intercepted:', response.url());  
      try {
          const text = await response.text();
          calendarData = JSON.parse(text);
          console.log('Calendar data intercepted!');
        } catch (e) {
          console.log('Calendar parse error:', e.message);
        }
      }
    });

    // Step 1 — visit homepage first to get Cloudflare clearance
    await page.goto('https://www.zipair.net/en', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });
    await new Promise(r => setTimeout(r, 5000));

    // Step 2 — navigate to search page which triggers the calendar API
    await page.goto(
      'https://www.zipair.net/en/flight/search?origin=LAX&destination=NRT&adult=3&childA=0&childB=0&childC=0&infant=0',
      { waitUntil: 'networkidle2', timeout: 60000 }
    );
    await new Promise(r => setTimeout(r, 10000));

    // Scroll to trigger any lazy loaded content
    await page.evaluate(() => window.scrollBy(0, 500));
    await new Promise(r => setTimeout(r, 5000));

    await browser.close();
    browser = null;

    if (!calendarData) {
      throw new Error('Calendar API was not intercepted.');
    }

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
