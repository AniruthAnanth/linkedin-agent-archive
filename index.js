// === Hyperparameters ===
const MAX_LIKES_PER_DAY = 6;
const MAX_COMMENTS_PER_DAY = 8;
const MAX_CONNECTS_PER_DAY = 4;

import {
  createBrowserSession,
  isLoggedIn,
  loginToLinkedIn,
  searchLinkedInForUser,
  randomDelay,
  scrapeLinkedInProfile,
  logToSupabase
} from './module.js';
import fs from 'fs';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Shared state for message passing between tasks
const agentState = {
  profileQueue: [], // URLs to process
  processedProfiles: new Set(),
  lastSearchQuery: null,
  lastScraped: null,
  connectedProfiles: new Set(),
  likesToday: 0,
  commentsToday: 0,
  connectsToday: 0,
};

// Task 1: Search for users and enqueue profile links
async function taskSearch(driver) {
  // Always generate a new query for each search
  const query = await generateQueryWithOpenAI();
  agentState.lastSearchQuery = query;
  if (usedQueries.slice(0, -1).includes(query)) { // Only the last push should be new
    console.log(`[Agent] Query already used: ${query}`);
    return;
  }
  const profiles = await searchLinkedInForUser(driver, { name: query });
  if (profiles && profiles.length > 0) {
    // Enqueue new profiles, no duplicates
    for (const url of profiles) {
      if (!agentState.processedProfiles.has(url) && !agentState.profileQueue.includes(url)) {
        agentState.profileQueue.push(url);
      }
    }
    console.log(`[Agent] Enqueued ${profiles.length} profiles from search: ${query}`);
  } else {
    console.log(`[Agent] No profiles found for query: ${query}`);
  }
  await randomDelay(1000, 2000);
}

// Task 2: Like a post on the feed (quota enforced)
async function taskLike(driver, scrollDuration = 120000) { // default 20 seconds
    // Go to the LinkedIn feed
    await driver.get('https://www.linkedin.com/feed/');
    await randomDelay(2000, 3500);

    // Scroll to load posts
    const startTime = Date.now();
    while (Date.now() - startTime < scrollDuration) {
        await driver.executeScript(`
            window.scrollBy(0, Math.floor(Math.random() * 200 + 100));
        `);
        await randomDelay(300, 700);
    }

    if (agentState.likesToday >= MAX_LIKES_PER_DAY) {
      console.log(`[Agent] Like quota reached for today (${MAX_LIKES_PER_DAY}). Delaying...`);
      await randomDelay(2000, 5000);
      return;
    }

    if (Math.random() < 0.3) {
        console.log(`[Agent] Randomly skipping like task this time.`);
        await randomDelay(2000, 5000);
        return;
    }

    // Try to find a "Like" button for a post in the feed
    const likeButtons = await driver.findElements({
        css: 'button[aria-label*="Like"], button[aria-label*="like"], button'
    });

    let found = false;
    for (const btn of likeButtons) {
        const text = await btn.getAttribute('innerText');
        const aria = await btn.getAttribute('aria-label');
        if (
            (text && text.toLowerCase().includes('like')) ||
            (aria && aria.toLowerCase().includes('like'))
        ) {
            await driver.executeScript("arguments[0].scrollIntoView({behavior: 'smooth', block: 'center'});", btn);
            await randomDelay(3000, 5000);
            await btn.click();
            found = true;
            break;
        }
    }
    if (found) {
        agentState.likesToday++;
        console.log(`[Agent] Liked a post on the feed (total today: ${agentState.likesToday})`);
    } else {
        console.log(`[Agent] No post like button found on the feed`);
    }
    await randomDelay(500, 1200);
}

// Task 3: Comment on a post in the feed (quota enforced)
async function taskComment(driver, scrollDuration = 120000) { // default 2 minutes
    // Go to the LinkedIn feed
    await driver.get('https://www.linkedin.com/feed/');
    await randomDelay(2000, 3500);

    // Scroll to load posts
    const startTime = Date.now();
    while (Date.now() - startTime < scrollDuration) {
        await driver.executeScript(`
            window.scrollBy(0, Math.floor(Math.random() * 200 + 100));
        `);
        await randomDelay(300, 700);
    }

    if (agentState.commentsToday >= MAX_COMMENTS_PER_DAY) {
        console.log(`[Agent] Comment quota reached for today (${MAX_COMMENTS_PER_DAY}). Delaying...`);
        await randomDelay(2000, 5000);
        return;
    }

    if (Math.random() < 0.3) {
      console.log(`[Agent] Randomly skipping comment task this time.`);
      await randomDelay(2000, 5000);
      return;
    }

    // Find all comment buttons on the page
    const commentButtons = await driver.findElements({
        css: 'button[aria-label*="Comment"], button[aria-label*="comment"]'
    });

    if (commentButtons.length === 0) {
        console.log(`[Agent] No comment buttons found on the feed.`);
        return;
    }

    // Pick a random comment button
    const randomIdx = Math.floor(Math.random() * commentButtons.length);
    const commentBtn = commentButtons[randomIdx];

    // Try to get the post content associated with the comment button
    let postContent = '';
    try {
        // Traverse up to the post container (usually an article or div)
        const postElement = await driver.executeScript(`
            let btn = arguments[0];
            let postContainer = btn;
            while (postContainer && !postContainer.closest('article, div.feed-shared-update-v2, div.feed-shared-update')) {
                postContainer = postContainer.parentElement;
            }
            postContainer = postContainer ? postContainer.closest('article, div.feed-shared-update-v2, div.feed-shared-update') : null;
            if (!postContainer) return '';
            // Now look for the main post text
            let textElem = postContainer.querySelector('.update-components-text');
            if (!textElem) return postContainer.innerText || '';
            return textElem.innerText || textElem.textContent || '';
        `, commentBtn);
        postContent = postElement || '';
    } catch (e) {
        postContent = '';
    }
    console.log('[Agent] Post content for comment:', postContent ? postContent.substring(0, 500) : '[No content found]');

    // Generate a sample comment using OpenAI
    let sampleComment = '';
    if (postContent) {
        try {
            const prompt = `Write a short, friendly, and relevant comment for the following LinkedIn post:\n"""${postContent.substring(0, 500)}""". Don't use hashtags, keep it pretty concise, and make your response slightly casual but professional.`;
            const response = await openai.chat.completions.create({
                model: 'gpt-3.5-turbo',
                messages: [
                    { role: 'system', content: 'You are a helpful assistant.' },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 60,
                temperature: 0.7,
            });
            sampleComment = response.choices[0].message.content.trim();
        } catch (e) {
            sampleComment = '[OpenAI error: could not generate comment]';
        }
    } else {
        sampleComment = '[No post content to generate comment]';
    }
    console.log('[Agent] Sample GPT comment:', sampleComment);

    // Scroll to the comment button and click it
    await driver.executeScript("arguments[0].scrollIntoView({behavior: 'smooth', block: 'center'});", commentBtn);
    await randomDelay(1000, 2000);
    await commentBtn.click();
    // Wait between 5000 and 10000 ms after clicking
    await randomDelay(5000, 10000);

    // Optionally, you could enter a comment here using driver.findElement and sendKeys
    agentState.commentsToday++;
    console.log(`[Agent] (Stub) Commented on feed post (total today: ${agentState.commentsToday})`);
    await randomDelay(800, 1500);
}

// Task 4: Scrape profile data
async function taskScrape(driver) {
  if (agentState.profileQueue.length === 0) return;
  const url = agentState.profileQueue.shift();
  if (agentState.processedProfiles.has(url)) return;
  // Check for duplicate in scraped_data.json
  const filename = 'scraped_data.json';
  let allData = [];
  let scrapedUrls = new Set();
  if (fs.existsSync(filename)) {
    try {
      const fileContent = fs.readFileSync(filename, 'utf-8');
      allData = JSON.parse(fileContent);
      if (!Array.isArray(allData)) allData = [];
      scrapedUrls = new Set(allData.map(entry => entry.url));
    } catch (e) {
      allData = [];
      scrapedUrls = new Set();
    }
  }
  if (scrapedUrls.has(url)) {
    console.log(`[Agent] Profile already scraped: ${url}`);
    return;
  }
  const data = await scrapeLinkedInProfile(driver, url);
  agentState.processedProfiles.add(url);
  agentState.lastScraped = url;
  allData.push({ url, ...data });
  fs.writeFileSync(filename, JSON.stringify(allData, null, 2));
  console.log(`[Agent] Scraped and appended profile to ${filename} (total: ${allData.length})`);
  await randomDelay(1000, 2000);
}

// Task 5: Connect with a user (quota enforced)
async function taskConnect(driver) {
  if (agentState.connectsToday >= MAX_CONNECTS_PER_DAY) {
    console.log(`[Agent] Connect quota reached for today (${MAX_CONNECTS_PER_DAY}). Delaying...`);
    await randomDelay(2000, 5000);
    return;
  }
  if (!agentState.lastScraped) return;
  if (agentState.connectedProfiles.has(agentState.lastScraped)) return;

  // Go to the last scraped profile's page
  const url = agentState.lastScraped;
  if (!url) {
    console.log('[Agent] No lastScraped profile URL available.');
    return;
  }
  await driver.get(url);
  await randomDelay(2000, 3500);

  // Try to find the 'Connect' button and click it
  let connectBtn = null;
  try {
    const buttons = await driver.findElements({ css: 'button' });
    for (const btn of buttons) {
      const text = (await btn.getAttribute('innerText')) || '';
      if (text.trim().toLowerCase().includes('connect')) {
        connectBtn = btn;
        break;
      }
    }
    if (connectBtn) {
      await driver.executeScript("arguments[0].scrollIntoView({behavior: 'smooth', block: 'center'});", connectBtn);
      await randomDelay(1000, 2000);
      await connectBtn.click();
      // Wait between 500 and 1000 ms
      await randomDelay(500, 1000);
      // Try to find and click the 'Send without a note' button
      try {
        const sendButtons = await driver.findElements({ css: 'button' });
        let sendBtn = null;
        for (const btn of sendButtons) {
          const spans = await btn.findElements({ css: 'span' });
          for (const span of spans) {
            const spanText = (await span.getAttribute('innerText')) || '';
            if (spanText.trim().toLowerCase().includes('send without a note')) {
              sendBtn = btn;
              break;
            }
          }
          if (sendBtn) break;
        }
        if (sendBtn) {
          await driver.executeScript("arguments[0].scrollIntoView({behavior: 'smooth', block: 'center'});", sendBtn);
          await randomDelay(1000, 2000);
          await sendBtn.click();
          await randomDelay(5000, 10000);
          console.log(`[Agent] Clicked 'Send without a note' to complete connection.`);
        } else {
          console.log(`[Agent] No 'Send without a note' button found after clicking Connect.`);
        }
      } catch (e) {
        console.log(`[Agent] Error trying to click 'Send without a note':`, e);
      }
      agentState.connectedProfiles.add(agentState.lastScraped);
      agentState.connectsToday++;
      console.log(`[Agent] Sent connection request to: ${agentState.lastScraped} (total today: ${agentState.connectsToday})`);
    } else {
      console.log(`[Agent] No 'Connect' button found on profile: ${agentState.lastScraped}`);
    }
  } catch (e) {
    console.log(`[Agent] Error trying to connect:`, e);
  }
  await randomDelay(1000, 2000);
}

// Helper: Generate a single LinkedIn search query using OpenAI (technology/AI/ML related)
const usedQueries = [];
async function generateQueryWithOpenAI() {
  let query = null;
  let attempts = 0;
  while ((!query || usedQueries.includes(query)) && attempts < 5) {
    const lastQueries = usedQueries.slice(-10);
    const prompt = `Generate a single realistic LinkedIn search query related to technology, such as AI/ML Applied Engineer, Data Scientist, or similar. Do not repeat any of these queries: ${JSON.stringify(lastQueries)}. Return your answer as a JSON object with a 'query' field, e.g. { "query": "Applied AI Engineer" } and nothing else.`;
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 60,
      temperature: 0.8,
      response_format: { type: 'json_object' },
    });
    const text = response.choices[0].message.content;
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj.query === 'string') query = obj.query.trim();
    } catch {}
    attempts++;
  }
  if (!query) query = 'Applied AI Engineer';
  usedQueries.push(query);
  return query;
}

// Central agent loop
async function agentMain() {
    let driver;
    const MAX_RUNTIME_MS = 60 * 60 * 1000; // 30 minutes
    const TASK_DELAY_MIN = 2 * 60 * 1000; // 30 seconds
    const TASK_DELAY_MAX = 5 * 60 * 1000; // 90 seconds

    try {
        driver = await createBrowserSession();
        if (!(await isLoggedIn(driver))) {
            const email = process.env.LINKEDIN_EMAIL;
            const password = process.env.LINKEDIN_PASSWORD;
            await loginToLinkedIn(driver, email, password);
            await randomDelay(1000, 2000);
        }
        console.log('[Agent] Ready to start.');

        const startTime = Date.now();
        let iteration = 0;
        let firstTaskDone = false;

        while (Date.now() - startTime < MAX_RUNTIME_MS) {
            let eligibleTasks = [taskSearch, taskScrape];
            if (agentState.likesToday < MAX_LIKES_PER_DAY) eligibleTasks.push(taskLike);
            /*if (agentState.commentsToday < MAX_COMMENTS_PER_DAY) eligibleTasks.push(taskComment);
            if (agentState.connectsToday < MAX_CONNECTS_PER_DAY) eligibleTasks.push(taskConnect);
            // Ensure like and comment have equal chance
            const likeIdx = eligibleTasks.indexOf(taskLike);
            const commentIdx = eligibleTasks.indexOf(taskComment);
            if (likeIdx !== -1 && commentIdx !== -1) {
                if (Math.random() < 0.5) {
                    [eligibleTasks[likeIdx], eligibleTasks[commentIdx]] = [eligibleTasks[commentIdx], eligibleTasks[likeIdx]];
                }
            }*/
            let task;
            if (!firstTaskDone) {
                task = taskSearch;
                firstTaskDone = true;
            } else {
                // Remove taskSearch from eligibleTasks for subsequent iterations
                const filteredTasks = eligibleTasks.filter(t => t !== taskSearch);
                task = filteredTasks[Math.floor(Math.random() * filteredTasks.length)];
            }
            console.log(`\n[Agent] Iteration ${iteration + 1}: Running task ${task.name}`);
            await task(driver);
            // Take a long break every ~20 minutes
            const elapsedMinutes = Math.floor((Date.now() - startTime) / (60 * 1000));
            if (elapsedMinutes > 0 && elapsedMinutes % 20 === 0) {
                console.log('[Agent] Taking a long break (simulating human idle)...');
                await randomDelay(25 * 60 * 1000, 35 * 60 * 1000); // 25-35 min
            } else {
                await randomDelay(TASK_DELAY_MIN, TASK_DELAY_MAX);
            }
            iteration++;
        }
        console.log('[Agent] Reached 1 hour runtime. Exiting.');
    } catch (error) {
        console.error('Error during LinkedIn agent automation:', error);
    } finally {
        if (driver) {
            await driver.quit();
        }
    }
}

async function forever() {
  while (true) {
    await logToSupabase("started running ");
    await agentMain();
    await logToSupabase("started sleeping ");
    console.log('[Agent] Sleeping for 5 hours before next run...');
    await randomDelay(5 * 60 * 60 * 1000, 8 * 60 * 60 * 1000); // 5 hours ± 1 min
  }
}

forever();