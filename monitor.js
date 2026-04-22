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

    // Intercept requests to bff.zipair.net and capture headers + response
    let capturedData = null;
    let capturedHeaders = null;

    await page.setRequestInterception(true);

    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('bff.zipair.net')) {
        console.log('Outgoing BFF request detected:', url);
        console.log('Request headers:', JSON.stringify(request.headers()));
        capturedHeaders = request.headers();
      }
      request.continue();
    });

    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('bff.zipair.net/v1/flights/calendar')) {
        try {
          console.log('Response status:', response.status());
          if (response.status() === 200) {
            capturedData = await response.json();
            console.log('Calendar API response intercepted ✅');
          } else {
            console.log('BFF API returned non-200:', response.status());
          }
        } catch (e) {
          console.log('Failed to parse response:', e.message);
        }
      }
    });

    // Step 1 — homepage for Cloudflare clearance
    console.log('Step 1: Loading homepage...');
    await page.goto('https://www.zipair.net/en', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });
    await new Promise(r => setTimeout(r, 6000));

    // Step 2 — search page to trigger calendar API call
    console.log('Step 2: Loading search page...');
    await page.goto(
      'https://www.zipair.net/en/flight/search?origin=LAX&destination=NRT&adult=3&childA=0&childB=0&childC=0&infant=0',
      { waitUntil: 'networkidle2', timeout: 60000 }
    );

    // Wait up to 30s for the API call to be intercepted
    console.log('Step 3: Waiting for calendar API call...');
    const maxWait = 30000;
    const interval = 500;
    let waited = 0;
    while (!capturedData && waited < maxWait) {
      await new Promise(r => setTimeout(r, interval));
      waited += interval;
    }

    // If page didn't call the API automatically, try scrolling to trigger it
    if (!capturedData) {
      console.log('No API call detected yet — trying scroll to trigger...');
      await page.evaluate(() => window.scrollBy(0, 500));
      await new Promise(r => setTimeout(r, 10000));
    }

    await browser.close();
    browser = null;

    if (!capturedData) {
      throw new Error(
        `Calendar API was never called by the page.\nCaptured headers: ${JSON.stringify(capturedHeaders)}`
      );
    }

    console.log('Raw API response (first 200 chars):', JSON.stringify(capturedData).substring(0, 200));
    console.log('Total dates returned:', capturedData.data.length);

    const available = capturedData.data.filter(d =>
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
