"use strict";
// =========================
// Imports
// =========================
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import xlsx from "xlsx";
import OpenAI from "openai";
import { Builder } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import dotenv from "dotenv";
import chalk from "chalk";
import ora from "ora";
import boxen from "boxen";
import { By, until, Key } from "selenium-webdriver";
import { createClient } from '@supabase/supabase-js';

// =========================
// Constants & Paths
// =========================
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const USER_DATA_DIR = path.join(__dirname, "chrome-data");
const OUTPUT_DIR = path.join(__dirname, "output");

const MAX_PAGE_NUMBERS = 10;

if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

dotenv.config();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const LINKEDIN_EMAIL = process.env.LINKEDIN_EMAIL;
const LINKEDIN_PASSWORD = process.env.LINKEDIN_PASSWORD;

// =========================
// Supabase Client Setup
// =========================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export async function logToSupabase(what) {
  try {
    await supabase.from('linkedin_diagnostic').insert([{ what }]);
    console.log("Logged to supabase")
  } catch (e) {
    // Optionally log to console if supabase logging fails
    console.error('[Supabase Log Error]', e.message);
  }
}

async function notifyUser() {
  console.log(
    chalk.yellow.bold(
      "Please log in to LinkedIn in the browser window that opens. The script will continue once you are logged in."
    )
  );
  console.log(
    chalk.gray(
      "If you encounter any issues, please check your LinkedIn credentials in the .env file."
    )
  );
  await randomDelay(10000, 15000);
}

// =========================
// Logger Utility
// =========================
const logger = {
  levels: {
    INFO: { color: "blue", emoji: "ℹ️" },
    SUCCESS: { color: "green", emoji: "✅" },
    WARNING: { color: "yellow", emoji: "⚠️" },
    ERROR: { color: "red", emoji: "❌" },
    DEBUG: { color: "cyan", emoji: "🔍" },
    STEP: { color: "magenta", emoji: "🔄" },
  },
  formatTime() { return chalk.gray(`[${new Date().toLocaleTimeString()}]`); },
  async info(message) {
    const { color, emoji } = this.levels.INFO;
    const out = `${this.formatTime()} ${chalk[color].bold(`${emoji} INFO:`)} ${message}`;
    console.log(out);
    await logToSupabase(out);
  },
  async success(message) {
    const { color, emoji } = this.levels.SUCCESS;
    const out = `${this.formatTime()} ${chalk[color].bold(`${emoji} SUCCESS:`)} ${message}`;
    console.log(out);
    await logToSupabase(out);
  },
  async warning(message) {
    const { color, emoji } = this.levels.WARNING;
    const out = `${this.formatTime()} ${chalk[color].bold(`${emoji} WARNING:`)} ${message}`;
    console.log(out);
    await logToSupabase(out);
  },
  async error(message, error = null) {
    const { color, emoji } = this.levels.ERROR;
    const out = `${this.formatTime()} ${chalk[color].bold(`${emoji} ERROR:`)} ${message}`;
    console.error(out);
    if (error && error.stack) {
      console.error(chalk.dim(error.stack));
      await logToSupabase(`${out}\n${error.stack}`);
    } else {
      await logToSupabase(out);
    }
  },
  async debug(message) {
    const { color, emoji } = this.levels.DEBUG;
    const out = `${this.formatTime()} ${chalk[color].bold(`${emoji} DEBUG:`)} ${message}`;
    console.log(out);
    await logToSupabase(out);
  },
  async step(message) {
    const { color, emoji } = this.levels.STEP;
    const out = `${this.formatTime()} ${chalk[color].bold(`${emoji} STEP:`)} ${message}`;
    console.log(out);
    await logToSupabase(out);
  },
  progress(current, total, prefix = "") { const percent = Math.round((current / total) * 100); const progressBar = Array(Math.floor(percent / 2)).fill("█").join(""); const emptyBar = Array(50 - Math.floor(percent / 2)).fill("░").join(""); console.log(`${this.formatTime()} ${chalk.blue(`⏳ PROGRESS:`)} ${prefix} ${chalk.cyan(`[${progressBar}${emptyBar}] ${percent}%`)} (${current}/${total})`); },
  spinner(text) { return ora({ text, color: "cyan", spinner: "dots" }); },
  box(message, title = "Notice") { console.log(boxen(message, { title, titleAlignment: "center", padding: 1, margin: 1, borderStyle: "round", borderColor: "cyan" })); },
  section(title) { console.log("\n" + chalk.bold.underline.bgBlue.white(` ${title} `) + "\n"); },
};

// =========================
// Rate Limiter for OpenAI API
// =========================
class OpenAIRateLimiter {
  constructor(options = {}) {
    this.options = { maxRequestsPerMinute: 3, maxTokensPerMinute: 40000, ...options };
    this.requestQueue = [];
    this.tokenUsage = [];
    this.pendingPromises = [];
    this.debug = options.debug || false;
  }
  log(message) { if (this.debug) { console.log(`[OpenAI Rate Limiter] ${message}`); } }
  estimateTokens(prompt) { return Math.ceil(prompt.length / 4); }
  cleanupOldRequests() { const now = Date.now(); const oneMinuteAgo = now - 60 * 1000; this.requestQueue = this.requestQueue.filter((time) => time > oneMinuteAgo); this.tokenUsage = this.tokenUsage.filter((item) => item.time > oneMinuteAgo); }
  getCurrentTokensPerMinute() { this.cleanupOldRequests(); return this.tokenUsage.reduce((sum, item) => sum + item.tokens, 0); }
  getCurrentRequestsPerMinute() { this.cleanupOldRequests(); return this.requestQueue.length; }
  getWaitTime(estimatedTokens) { this.cleanupOldRequests(); const currentRequests = this.getCurrentRequestsPerMinute(); const currentTokens = this.getCurrentTokensPerMinute(); if (currentRequests < this.options.maxRequestsPerMinute && currentTokens + estimatedTokens <= this.options.maxTokensPerMinute) { return 0; } if (this.requestQueue.length > 0) { const oldestRequest = Math.min(...this.requestQueue); const timeUntilSlotFrees = oldestRequest + 60 * 1000 - Date.now(); return Math.max(0, timeUntilSlotFrees); } return 0; }
  async rateLimit(promptText, apiCallFn) { const estimatedTokens = this.estimateTokens(promptText); const waitTime = this.getWaitTime(estimatedTokens); if (waitTime > 0) { this.log(`Rate limit reached. Waiting ${waitTime}ms before next request...`); await new Promise((resolve) => setTimeout(resolve, waitTime)); } const requestTime = Date.now(); this.requestQueue.push(requestTime); try { const result = await apiCallFn(); const tokensUsed = result.usage?.total_tokens || estimatedTokens; this.tokenUsage.push({ time: requestTime, tokens: tokensUsed }); this.log(`Request completed. Used ${tokensUsed} tokens. Current usage: ${this.getCurrentRequestsPerMinute()}/${this.options.maxRequestsPerMinute} requests, ${this.getCurrentTokensPerMinute()}/${this.options.maxTokensPerMinute} tokens per minute.`); return result; } catch (error) { if (error.status === 429) { this.log("Received 429 Rate Limit Error from OpenAI API"); const retryAfter = error.headers?.["retry-after"] ? parseInt(error.headers["retry-after"]) * 1000 : 60000; this.log(`Will retry after ${retryAfter}ms`); await new Promise((resolve) => setTimeout(resolve, retryAfter)); return this.rateLimit(promptText, apiCallFn); } throw error; } }
}

const rateLimiter = new OpenAIRateLimiter({ maxRequestsPerMinute: 5000, maxTokensPerMinute: 4000000, debug: false });

// =========================
// Utility Functions
// =========================
function computeExperienceYears(experiences, education) {
  const now = new Date();
  const thisYear = now.getFullYear();

  // 1) Pull *every* 4‑digit year from each education.dates
  let gradYear = null;
  for (const ed of education || []) {
    const years = Array.from(ed.dates.matchAll(/\b(\d{4})\b/g), (m) =>
      parseInt(m[1], 10)
    );
    if (years.length) {
      const maxEd = Math.max(...years);
      gradYear = gradYear === null ? maxEd : Math.max(gradYear, maxEd);
    }
  }

  // 2) If no graduation year found, fall back to number of experiences
  if (gradYear === null) {
    return experiences.length;
  }

  // 3) Extract each experience's start year
  const postGradStarts = experiences
    .map((exp) => {
      const m = exp.dateDuration.match(/\b[A-Za-z]{3,9}\s+(\d{4})\b/);
      return m ? parseInt(m[1], 10) : null;
    })
    // 4) Keep only those strictly after graduation
    .filter((y) => y !== null && y > gradYear);

  // 5) If none start after graduation, zero years
  if (postGradStarts.length === 0) {
    return 0;
  }

  // 6) Earliest post‑grad start → compute full years since then
  const firstYear = Math.min(...postGradStarts);
  return thisYear - firstYear;
}

const randomDelay = async (min = 800, max = 1500) => {
  const delay = Math.floor(Math.random() * (max - min)) + min;
  console.log(`[Agent] Waiting for ${delay}ms...`);
  await logToSupabase(`Waiting for ${delay}ms...`);
  return new Promise((resolve) => setTimeout(resolve, delay));
};

function getRandomUserAgent() {
  const userAgents = [
    // Chrome on Windows
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    // Chrome on Mac
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    // Firefox on Windows
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/117.0",
    // Edge on Windows
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
    // Chrome on Linux
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

async function humanType(element, text, minDelay = 60, maxDelay = 180) {
  for (const char of text) {
    await element.sendKeys(char);
    await randomDelay(minDelay, maxDelay);
    // Occasionally pause longer
    if (Math.random() < 0.08) await randomDelay(200, 400);
  }
}

async function humanScroll(driver, minScrolls = 2, maxScrolls = 6) {
  const scrolls = Math.floor(Math.random() * (maxScrolls - minScrolls + 1)) + minScrolls;
  for (let i = 0; i < scrolls; i++) {
    const scrollY = Math.floor(Math.random() * 400) + 100;
    await driver.executeScript(`window.scrollBy(0, ${scrollY});`);
    await randomDelay(300, 900);
  }
  // Occasionally scroll back up
  if (Math.random() < 0.2) {
    await driver.executeScript(`window.scrollBy(0, -200);`);
    await randomDelay(200, 600);
  }
}

async function humanMouseMove(driver) {
  // Move mouse to a random position on the page
  const x = Math.floor(Math.random() * 800) + 200;
  const y = Math.floor(Math.random() * 400) + 200;
  try {
    await driver.actions({ bridge: true }).move({ x, y }).perform();
    await randomDelay(80, 200);
  } catch (e) {
    // Ignore if not supported
  }
}

// =========================
// Browser Session Management
// =========================
async function createBrowserSession() {
  const spinner = logger.spinner("Creating browser session");
  spinner.start();

  // Configure Chrome options to make it look like a real user
  const options = new chrome.Options();

  options.addArguments(
    `--user-data-dir=${USER_DATA_DIR}`,
    "--window-size=1920,1080",
    "--disable-blink-features=AutomationControlled",
    "--disable-extensions",
    "--no-sandbox",
    "--disable-infobars",
    "--disable-dev-shm-usage"
    // "--headless=new" // Uncomment for headless mode
  );
  options.setUserPreferences({
    "profile.default_content_setting_values.notifications": 2,
    credentials_enable_service: false,
    "profile.password_manager_enabled": false,
  });
  // Use a random user agent for each session
  options.addArguments(`--user-agent=${getRandomUserAgent()}`);

  try {
    const driver = await new Builder()
      .forBrowser("chrome")
      .setChromeOptions(options)
      .build();
    spinner.succeed("Browser session created successfully");
    return driver;
  } catch (error) {
    spinner.fail("Failed to create browser session");
    logger.error("Browser creation error", error);
    throw error;
  }
}

async function recoverBrowserSession() {
  logger.warning(
    "Browser session appears to be closed or crashed. Attempting to recover..."
  );

  try {
    // Close the existing driver if it exists
    if (driver) {
      try {
        await driver.quit();
      } catch (e) {
        // Ignore errors from quitting an already dead driver
      }
    }

    // Create a new browser session
    logger.info("Creating new browser session...");
    driver = await createBrowserSession();

    // Check if we need to log in again
    if (!(await isLoggedIn(driver))) {
      logger.info("Logging in to LinkedIn again...");
      await loginToLinkedIn(driver, LINKEDIN_EMAIL, LINKEDIN_PASSWORD);
    }

    logger.success("Browser session recovered successfully");
    return driver;
  } catch (error) {
    logger.error("Failed to recover browser session", error);
    throw error;
  }
}

// =========================
// LinkedIn Authentication
// =========================
async function waitForAuthCodeVerification(driver) {
  logger.box(
    `LinkedIn authentication code verification detected!\n\n` +
      `1. Check your email/phone for the verification code sent by LinkedIn\n` +
      `2. Enter the code in the LinkedIn verification page\n` +
      `3. Press Enter in this console after entering the code`,
    "Auth Code Verification"
  );

  // Create a promise that will resolve when Enter is pressed
  await new Promise((resolve) => {
    process.stdin.once("data", () => {
      resolve();
    });

    // Make sure input is being read
    if (!process.stdin.isRaw) {
      process.stdin.setRawMode && process.stdin.setRawMode(true);
    }
    process.stdin.resume();
  });

  logger.success(
    "Authentication code verification completed. Continuing script execution..."
  );

  // Add a short delay after verification to ensure the page has fully loaded
  await randomDelay(2000, 3000);
}

async function waitForManualVerification(
  driver,
  message = "Manual verification required"
) {
  // Check if we're on the mobile app verification screen
  const isMobileVerification = await driver
    .executeScript(
      `
    return document.querySelector('.header__content__heading__inapp') !== null &&
           document.body.innerText.includes('Check your LinkedIn app');
  `
    )
    .catch(() => false);

  // Check if we're on the auth code verification screen
  const isAuthCodeVerification = await driver
    .executeScript(
      `
    return document.querySelector('input[name="pin"]') !== null ||
           document.body.innerText.includes('security code') ||
           document.body.innerText.includes('verification code');
  `
    )
    .catch(() => false);

  if (isMobileVerification) {
    logger.box(
      `LinkedIn mobile app verification detected!\n\n` +
        `1. Check your LinkedIn mobile app for the verification notification\n` +
        `2. Tap "Yes" in your LinkedIn app to approve the login\n` +
        `3. Press Enter in this console after completing the verification`,
      "Mobile App Verification"
    );
  } else if (isAuthCodeVerification) {
    logger.box(
      `LinkedIn authentication code verification detected!\n\n` +
        `1. Check your email/phone for the verification code sent by LinkedIn\n` +
        `2. Enter the code in the LinkedIn verification page\n` +
        `3. Press Enter in this console after entering the code`,
      "Auth Code Verification"
    );

    // Wait for user to enter the code in the browser
    // You could optionally add code here to let the user input the code in the console
    // and then have the script enter it into the browser
  } else {
    logger.box(
      `${message}\n\nThe script will continue when you press Enter in the console.`,
      "Manual Verification"
    );
  }

  // Create a promise that will resolve when Enter is pressed
  await new Promise((resolve) => {
    process.stdin.once("data", () => {
      resolve();
    });

    // Make sure input is being read
    if (!process.stdin.isRaw) {
      process.stdin.setRawMode && process.stdin.setRawMode(true);
    }
    process.stdin.resume();
  });

  logger.success(
    "Manual verification completed. Continuing script execution..."
  );

  // Add a short delay after verification to ensure the page has fully loaded
  await randomDelay(2000, 3000);
}

async function isLoggedIn(driver) {
  const spinner = logger.spinner("Checking LinkedIn login status");
  spinner.start();

  try {
    await driver.get("https://www.linkedin.com/feed/");
    await randomDelay(800, 1000);
    const currentUrl = await driver.getCurrentUrl();
    const loggedIn =
      !currentUrl.includes("login") && !currentUrl.includes("checkpoint");

    if (loggedIn) {
      spinner.succeed("Already logged in to LinkedIn");
      return true;
    }

    // If not logged in, check for a button with a child containing the username
    const username = process.env.LINKEDIN_USERNAME;
    let loginAttempted = false;
    if (username) {
      // Try to click the button with the username, retry up to 3 times
      for (let attempt = 0; attempt < 3; attempt++) {
        const buttonClicked = await driver.executeScript(`
        const username = arguments[0];
        const buttons = Array.from(document.querySelectorAll('button'));
        for (const btn of buttons) {
          if (Array.from(btn.querySelectorAll('*')).some(child => child.textContent.trim() === username)) {
          btn.click();
          return true;
          }
        }
        return false;
        `, username);
        if (buttonClicked) {
          spinner.info(`Clicked button for username: ${username}`);
          await randomDelay(5000, 7000);
          const newUrl = await driver.getCurrentUrl();
          const nowLoggedIn = !newUrl.includes("login") && !newUrl.includes("checkpoint");
          if (nowLoggedIn) {
            spinner.succeed("Logged in to LinkedIn after clicking username button");
            return true;
          }
        }
      }
      // Try to click the button with text "LinkedIn User", retry up to 3 times
      for (let attempt = 0; attempt < 3; attempt++) {
        const fallbackClicked = await driver.executeScript(`
          const fallbackText = "LinkedIn User";
          const buttons = Array.from(document.querySelectorAll('button'));
          for (const btn of buttons) {
          if (Array.from(btn.querySelectorAll('*')).some(child => child.textContent.trim() === fallbackText)) {
            btn.click();
            return true;
          }
          }
          return false;
        `);
        if (fallbackClicked) {
          spinner.info(`Clicked button for fallback: LinkedIn User`);
          await randomDelay(5000, 7000);
          const newUrl = await driver.getCurrentUrl();
          const nowLoggedIn = !newUrl.includes("login") && !newUrl.includes("checkpoint");
          if (nowLoggedIn) {
            spinner.succeed("Logged in to LinkedIn after clicking fallback button");
            return true;
          }
        }
      }
    }

    // If still not logged in, notify user and wait for manual intervention
    spinner.info("LinkedIn login required");
    notifyUser();
    console.log('[Agent] Waiting for user to log in manually. Press Enter to continue...');
    await new Promise((resolve) => {
      process.stdin.once("data", () => resolve());
      if (!process.stdin.isRaw) {
        process.stdin.setRawMode && process.stdin.setRawMode(true);
      }
      process.stdin.resume();
    });
    // After user intervention, check again
    await randomDelay(2000, 3000);
    const finalUrl = await driver.getCurrentUrl();
    const finalLoggedIn = !finalUrl.includes("login") && !finalUrl.includes("checkpoint");
    if (finalLoggedIn) {
      spinner.succeed("Logged in to LinkedIn after user intervention");
      return true;
    }
    spinner.fail("LinkedIn login still required after user intervention");
    return false;
  } catch (error) {
    spinner.fail("Error checking login status");
    logger.error("Login check failed", error);
    return false;
  }
}

async function loginToLinkedIn(driver, email, password) {
  const spinner = logger.spinner("Logging in to LinkedIn");
  spinner.start();

  try {
    // Navigate to LinkedIn login page
    await driver.get("https://www.linkedin.com/login");
    await randomDelay();

    // Enter email, password, and login
    await driver.findElement(By.id("username")).sendKeys(email);
    await driver.findElement(By.id("password")).sendKeys(password);
    await driver.findElement(By.css("button[type='submit']")).click();

    // Add a delay after login attempt
    await randomDelay(1000, 2000);

    // Check for different verification scenarios
    const bodyText = await driver.executeScript(
      "return document.body.innerText"
    );

    // Check for mobile app verification screen
    const isMobileVerification = await driver
      .executeScript(
        `
      return document.querySelector('.header__content__heading__inapp') !== null &&
             document.body.innerText.includes('Check your LinkedIn app');
    `
      )
      .catch(() => false);

    // Check for auth code verification screen
    const isAuthCodeVerification = await driver
      .executeScript(
        `
      return document.querySelector('input[name="pin"]') !== null ||
             document.body.innerText.includes('security code') ||
             document.body.innerText.includes('verification code');
    `
      )
      .catch(() => false);

    if (isMobileVerification) {
      spinner.info("LinkedIn mobile app verification detected");
      await waitForManualVerification(driver);
    } else if (isAuthCodeVerification) {
      spinner.info("LinkedIn authentication code verification detected");
      // Use the advanced option if you want to input code via console
      await waitForAuthCodeVerification(driver);
      // Or use the simpler option for manual input
      // await waitForManualVerification(driver, "Please enter the authentication code in the browser");
    }
    // Check for other verification methods
    else if (
      bodyText.includes("verification") ||
      bodyText.includes("security check") ||
      bodyText.includes("confirm your identity")
    ) {
      // Pause for manual verification
      spinner.info("LinkedIn verification required");
      await waitForManualVerification(
        driver,
        "LinkedIn verification detected. Please complete the verification manually."
      );
    }

    // Verify login was successful
    const currentUrl = await driver.getCurrentUrl();
    if (currentUrl.includes("feed") || !currentUrl.includes("login")) {
      spinner.succeed("LinkedIn login successful");
      return true;
    } else {
      spinner.fail("LinkedIn login failed - check credentials");
      return false;
    }
  } catch (error) {
    spinner.fail("LinkedIn login error");
    logger.error("Login process failed", error);
    return false;
  }
}

// =========================
// LinkedIn Profile Scraping
// =========================
async function scrapeLinkedInProfile(driver, url) {
  const spinner = logger.spinner(
    `Scraping LinkedIn profile: ${chalk.cyan(url)}`
  );
  spinner.start();

  try {
    // Extract the username from the LinkedIn URL for detailed page navigation
    const urlMatch = url.match(/linkedin\.com\/in\/([^\/]+)/);
    if (!urlMatch || !urlMatch[1]) {
      spinner.fail("Invalid LinkedIn URL format");
      return { error: "Invalid LinkedIn URL format" };
    }
    const username = urlMatch[1];

    // --- Human-like: scroll and mouse move before visiting profile ---
    await humanScroll(driver, 2, 4);
    await humanMouseMove(driver);
    await randomDelay(400, 1200);

    // First visit the main profile page
    await driver.get(url);
    await randomDelay(2000, 3500);
    await humanScroll(driver, 3, 7);
    await humanMouseMove(driver);
    await randomDelay(500, 1200);

    // Check if we're on the login page (session might have expired)
    const currentUrl = await driver.getCurrentUrl();
    if (currentUrl.includes("authwall") || currentUrl.includes("login")) {
      spinner.fail("LinkedIn session expired");
      throw new Error("LinkedIn session expired. Need to login again.");
    }

    spinner.text = "Extracting basic profile information";

    // --- Human-like: scroll and mouse move before extracting info ---
    await humanScroll(driver, 1, 3);
    await humanMouseMove(driver);
    await randomDelay(200, 600);

    // Extract basic profile information
    let name, headline, about;
    try {
      const nameElem = await driver.findElement(By.css("h1.inline.t-24.v-align-middle.break-words"));
      await humanMouseMove(driver);
      await randomDelay(100, 300);
      name = await nameElem.getText();
    } catch { name = "Unknown Name"; }
    try {
      const headlineElem = await driver.findElement(By.css("div.text-body-medium.break-words"));
      await humanMouseMove(driver);
      await randomDelay(100, 300);
      headline = await headlineElem.getText();
    } catch { headline = ""; }
    try {
      const aboutElem = await driver.findElement(By.css("div.inline-show-more-text--is-collapsed.full-width span[aria-hidden='true']"));
      await humanMouseMove(driver);
      await randomDelay(100, 300);
      about = await aboutElem.getText();
    } catch { about = ""; }

    // --- Human-like: scroll before navigating to experience ---
    await humanScroll(driver, 1, 2);
    await randomDelay(200, 600);

    // Navigate to the experience details page
    spinner.text = "Extracting experience information";
    const experienceUrl = `https://www.linkedin.com/in/${username}/details/experience/`;
    await driver.get(experienceUrl);
    await randomDelay(800, 1800);
    await humanScroll(driver, 2, 5);
    await humanMouseMove(driver);

    // Extract experiences
    const experiences = [];
    try {
      // Wait for experience items to load
      await driver.wait(
        until.elementsLocated(By.css(".pvs-list__paged-list-item")),
        10000
      );

      // Get all experience items
      const experienceItems = await driver.findElements(
        By.css(".pvs-list__paged-list-item")
      );

      for (const item of experienceItems) {
        try {
          await humanMouseMove(driver);
          await randomDelay(80, 200);
          const titleElem = await item.findElement(By.css("div.align-items-center.t-bold"));
          const title = await titleElem.getText().catch(() => "");
          await randomDelay(60, 180);
          const companyElem = await item.findElement(By.css("span.t-14.t-normal"));
          const company = await companyElem.getText().catch(() => "");
          await randomDelay(60, 180);
          const dateElem = await item.findElement(By.css("span.t-black--light"));
          const dateDuration = await dateElem.getText().catch(() => "");
          experiences.push({ title, company, dateDuration });
        } catch (e) {
          logger.debug("Error extracting an experience item: " + e.message);
        }
      }
    } catch (e) {
      logger.debug("Error extracting experiences: " + e.message);
    }

    // --- Human-like: scroll before navigating to education ---
    await humanScroll(driver, 1, 2);
    await randomDelay(200, 600);

    // Navigate to the education details page
    spinner.text = "Extracting education information";
    const educationUrl = `https://www.linkedin.com/in/${username}/details/education/`;
    await driver.get(educationUrl);
    await randomDelay(800, 1800);
    await humanScroll(driver, 2, 5);
    await humanMouseMove(driver);

    // Extract education
    const education = [];
    try {
      // Wait for education items to load
      await driver.wait(
        until.elementsLocated(By.css(".pvs-list__paged-list-item")),
        10000
      );

      // Get all education items
      const educationItems = await driver.findElements(
        By.css(".pvs-list__paged-list-item")
      );

      for (const item of educationItems) {
        try {
          await humanMouseMove(driver);
          await randomDelay(80, 200);
          const schoolElem = await item.findElement(By.css("div.align-items-center.t-bold"));
          const school = await schoolElem.getText().catch(() => "");
          await randomDelay(60, 180);
          const degreeElem = await item.findElement(By.css("span.t-14.t-normal"));
          const degree = await degreeElem.getText().catch(() => "");
          await randomDelay(60, 180);
          const datesElem = await item.findElement(By.css("span.t-black--light"));
          const dates = await datesElem.getText().catch(() => "");
          education.push({ school, degree, dates });
        } catch (e) {
          logger.debug("Error extracting an education item: " + e.message);
        }
      }
    } catch (e) {
      logger.debug("Error extracting education: " + e.message);
    }

    // Format education and experience for Excel
    const educationText = education
      .map(
        (edu) =>
          `${edu.school || "Unknown School"}${
            edu.degree ? `: ${edu.degree}` : ""
          }${edu.dates ? ` (${edu.dates})` : ""}`
      )
      .join("; ");

    const experienceText = experiences
      .map(
        (exp) =>
          `${exp.title || "Unknown Title"}${
            exp.company ? ` at ${exp.company}` : ""
          }${exp.dateDuration ? ` (${exp.dateDuration})` : ""}`
      )
      .join("; ");

    spinner.succeed(`Profile data extracted for ${chalk.bold(name)}`);

    // Return the formatted data
    return {
      url,
      name,
      headline,
      about,
      educationText,
      experienceText,
      education,
      experiences,
    };
  } catch (error) {
    spinner.fail(`LinkedIn profile scraping failed: ${error.message}`);
    logger.error(`Scraping error`, error);
    throw error;
  }
}

// =========================
// OpenAI Keyword Generation
// =========================
async function generateKeywords(user, profile, websiteText = "") {
  const spinner = logger.spinner("Generating profile keywords");
  spinner.start();

  try {
    // Compile relevant information
    const twitterBio = user.description || "";
    const education = profile.linkedin_education || "";
    const experience = profile.linkedin_experience || "";

    // Truncate website text if it's too long for the GPT prompt
    const MAX_WEBSITE_TEXT_LENGTH = 5000;
    const truncatedWebsiteText =
      websiteText.length > MAX_WEBSITE_TEXT_LENGTH
        ? websiteText.substring(0, MAX_WEBSITE_TEXT_LENGTH) + "... [truncated]"
        : websiteText;

    // Create a prompt for OpenAI
    const prompt = `
      Extract relevant professional keywords from this profile. Include ONLY companies, education, roles, and technical skills.
      
      Return ONLY a comma-separated list of keywords, with no explanation or other text.
    
      Twitter Bio: ${twitterBio}
      
      Education:
      ${education || "No education information available"}
      
      Experience:
      ${experience || "No experience information available"}
      
      Website Text:
      ${truncatedWebsiteText || "No website text available"}
    `;

    // Call OpenAI API
    const response = await rateLimiter.rateLimit(prompt, async () => {
      return await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 150,
      });
    });

    const keywords = response.choices[0].message.content.trim();
    spinner.succeed("Keywords generated successfully");
    return keywords;
  } catch (error) {
    spinner.fail(`Keyword generation failed: ${error.message}`);
    logger.error("Error generating keywords:", error);
    return "Keyword extraction failed";
  }
}

// =========================
// User Processing
// =========================
async function processUser(driver, user, websiteText) {
  // Use consistent property access and provide fallbacks
  const name = user.Name || "";
  const twitterUsername = user.screen_name || user["Twitter User"] || "";
  const twitterURL =
    user["Twitter URL"] || `https://twitter.com/${twitterUsername}`;
  const linkedInUrl = user["LinkedIn URL"] || "";
  const personalWebsite = user["Personal Website"] || "";
  const twitterBio = user.description || user["Twitter Bio"] || "";

  logger.section(
    `Processing user: ${chalk.bold(name)} (${
      twitterUsername ? "@" + twitterUsername : ""
    })`
  );

  let profileData = {
    educationText: "",
    experienceText: "",
    headline: "",
    about: "",
  };

  // If LinkedIn URL was found in the input file, scrape the profile
  if (linkedInUrl) {
    try {
      logger.step(`Scraping LinkedIn profile: ${chalk.cyan(linkedInUrl)}`);

      // Add retry logic for LinkedIn profile scraping
      let retryCount = 0;
      const MAX_RETRIES = 2;

      while (retryCount <= MAX_RETRIES) {
        try {
          profileData = await scrapeLinkedInProfile(driver, linkedInUrl);
          break; // Success, exit the retry loop
        } catch (scrapeError) {
          retryCount++;

          if (retryCount <= MAX_RETRIES) {
            logger.warning(
              `LinkedIn scraping failed, retry ${retryCount}/${MAX_RETRIES}`
            );
            await randomDelay(2000, 3000); // Wait before retry
          } else {
            throw scrapeError; // Re-throw if all retries failed
          }
        }
      }
    } catch (error) {
      logger.error(`LinkedIn profile scraping failed: ${error.message}`);
    }
  } else {
    logger.warning(`No LinkedIn URL found for ${name}`);
  }

  // Create user object for keyword generation with consistent properties
  const userForKeywords = {
    name: name,
    description: twitterBio,
  };

  // Prepare profile data for keyword generation
  const profileForKeywords = {
    linkedin_education: profileData.educationText || "",
    linkedin_experience: profileData.experienceText || "",
  };

  // Generate keywords
  const keywords = await generateKeywords(
    userForKeywords,
    profileForKeywords,
    websiteText
  );

  // Return the complete user data
  return {
    Name: name,
    "Twitter URL": twitterURL,
    "LinkedIn URL": linkedInUrl,
    "Personal Website": personalWebsite,
    "LinkedIn Education": profileData.educationText || "",
    "LinkedIn Experience": profileData.experienceText || "",
    Keywords: keywords,
    rawEducation: profileData.education || [],
    rawExperiences: profileData.experiences || [],
  };
}

// =========================
// Main Processing Logic
// =========================
async function main(inputFile) {
  let driver = null;

  try {
    logger.box(`LinkedIn Profile Data Collection`, "Starting Process");

    // Step 1: Read the Excel file with users
    logger.section("Reading Input Data");
    const spinner = logger.spinner(
      `Reading Excel file: ${chalk.cyan(inputFile)}`
    );
    spinner.start();

    let users = [];
    try {
      // Read the Excel file
      const workbook = xlsx.readFile(inputFile);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];

      // Convert to JSON format with header row
      users = xlsx.utils.sheet_to_json(worksheet);

      if (users.length === 0) {
        spinner.fail("No users found in the Excel file");
        return "No users found. Process aborted.";
      }

      spinner.succeed(`Found ${chalk.bold(users.length)} users in input file`);
    } catch (error) {
      spinner.fail(`Failed to read Excel file`);
      logger.error("Excel reading error", error);
      throw error;
    }

    // Step 2: Create output Excel file
    const outputFileName = path.join(OUTPUT_DIR, "talent-pool.xlsx");
    const headers = [
      "Name",
      "Twitter URL",
      "LinkedIn URL",
      "Personal Website",
      "LinkedIn Education",
      "LinkedIn Experience",
      "Keywords",
    ];

    const workbook = xlsx.utils.book_new();
    const worksheet = xlsx.utils.aoa_to_sheet([headers]);
    xlsx.utils.book_append_sheet(workbook, worksheet, "LinkedIn Profiles");
    xlsx.writeFile(workbook, outputFileName);
    logger.success(
      `Initialized Excel output file: ${chalk.cyan(outputFileName)}`
    );

    // Step 3: Initialize browser session and login to LinkedIn
    logger.section("Setting up LinkedIn access");
    driver = await createBrowserSession();

    if (!(await isLoggedIn(driver))) {
      await loginToLinkedIn(driver, LINKEDIN_EMAIL, LINKEDIN_PASSWORD);
    }

    // Step 4: Process each user and append results incrementally
    logger.section("Processing user profiles");
    const results = [];

    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const name = user.Name || "Unknown";
      logger.progress(i + 1, users.length, "Processing users");

      // Add a small delay between users
      if (i > 0) {
        const waitTime = 500 + Math.random() * 500;
        logger.debug(`Waiting ${Math.round(waitTime)}ms before next user...`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }

      try {
        // Check if browser is still alive
        try {
          await driver.getCurrentUrl();
        } catch (browserError) {
          if (
            browserError.name === "NoSuchWindowError" ||
            browserError.message.includes("target window already closed")
          ) {
            // Browser crashed, attempt to recover
            driver = await recoverBrowserSession();
          }
        }

        // Get website text from input
        const websiteText = user["Website Text"] || "";

        // Process the current user
        const userData = await processUser(driver, user, websiteText);

        // 1) compute years of post‑grad experience
        const yearsOfExp = computeExperienceYears(
          userData.rawExperiences,
          userData.rawEducation
        );

        // 2) collect education entries
        const educationList = userData.rawEducation || [];

        // 3) filter bachelor & master entries
        const bachelorEd = educationList.filter((ed) =>
          /\bBachelor\b/i.test(ed.degree || "")
        );
        const masterEd = educationList.filter((ed) =>
          /\bMaster\b/i.test(ed.degree || "")
        );

        // 4) detect entries with no year at all
        const hasEduNoYear =
          educationList.length > 0 &&
          educationList.every((ed) => !(ed.dates || "").match(/\d{4}/));

        // 5) helper to extract an end‑year
        const now = new Date();
        const thisYear = now.getFullYear();
        const endYearOf = (ed) => {
          const dates = ed.dates || "";
          // 1) strict "2020 - 2023" or "2020 - Present"
          let m = dates.match(/(\d{4})\s*-\s*(\d{4}|Present)/);
          if (m) {
            return m[2] === "Present" ? thisYear : parseInt(m[2], 10);
          }

          // 2) fallback: grab *all* standalone years and pick the latest
          const allYears = Array.from(dates.matchAll(/\b(\d{4})\b/g), (x) =>
            parseInt(x[1], 10)
          );
          if (allYears.length) {
            return Math.max(...allYears);
          }

          return null;
        };

        // 6) check "recent" completions
        const hasRecentBachelor = bachelorEd.some((ed) => {
          const y = endYearOf(ed);
          return y !== null && y >= thisYear - 2;
        });
        const hasRecentMaster = masterEd.some((ed) => {
          const y = endYearOf(ed);
          return y !== null && y >= thisYear - 1;
        });

        // 7) check "current" degrees by end‐year = thisYear
        const hasCurrentBachelor = bachelorEd.some(
          (ed) => endYearOf(ed) === thisYear
        );
        const hasCurrentMaster = masterEd.some(
          (ed) => endYearOf(ed) === thisYear
        );

        // 8) decide inclusion
        const noEducation = educationList.length === 0;
        if (
          !(
            hasCurrentMaster ||
            hasRecentMaster ||
            hasCurrentBachelor ||
            hasRecentBachelor ||
            (hasEduNoYear && yearsOfExp < 6) ||
            (noEducation && yearsOfExp < 6)
          )
        ) {
          logger.info(
            `Skipping ${userData.Name}: ` +
              `CM?${hasCurrentMaster}, M≤1?${hasRecentMaster}, ` +
              `CB?${hasCurrentBachelor}, B≤2?${hasRecentBachelor}, ` +
              `edu-no-year & exp<6?${hasEduNoYear && yearsOfExp < 6}, ` +
              `no-edu & exp<6?${noEducation && yearsOfExp < 6}`
          );
          continue; // Skip this user
        }

        // Only if the user passes filtering, proceed to add them to results
        results.push(userData);

        // Create a cleaned version of userData without raw fields
        const cleanedUserData = {
          Name: userData.Name,
          "Twitter URL": userData["Twitter URL"],
          "LinkedIn URL": userData["LinkedIn URL"],
          "Personal Website": userData["Personal Website"],
          "LinkedIn Education": userData["LinkedIn Education"],
          "LinkedIn Experience": userData["LinkedIn Experience"],
          Keywords: userData.Keywords,
        };

        // Append to Excel using the cleaned data
        xlsx.utils.sheet_add_json(worksheet, [cleanedUserData], {
          skipHeader: true,
          origin: -1,
        });
        xlsx.writeFile(workbook, outputFileName);
        logger.debug(`Added ${name}'s data to Excel file`);
      } catch (error) {
        logger.error(`Failed to process user ${name}`, error);
      }
    }

    // Final summary
    logger.box(
      `Data Collection Complete!\n\n` +
        `👤 Processed ${chalk.bold(users.length)} users\n` +
        `🔍 Found ${chalk.bold(
          results.filter((r) => r["LinkedIn URL"]).length
        )} LinkedIn profiles\n` +
        `💾 Results saved to ${chalk.cyan(outputFileName)}`,
      "Process Summary"
    );

    return `Data collection complete. Found ${
      results.filter((r) => r["LinkedIn URL"]).length
    } LinkedIn profiles out of ${users.length} users.`;
  } catch (error) {
    logger.error(`Script execution failed`, error);
    throw error;
  } finally {
    if (driver) {
      logger.info("Closing browser session...");
      await driver.quit();
    }
  }
}

// =========================
// LinkedIn Search Utility
// =========================
export async function searchLinkedInForUser(driver, user) {
  const searchSelectors = [
      "input.search-global-typeahead__input",
      "input[aria-label='Search']",
      "input.search-box__input",
      "input[placeholder*='Search']",
      "form.search-global-typeahead button",
  ];

  let searchBox = null;
  let foundSelector = "";

  try {
      // Make sure we're on LinkedIn before attempting search
      if (!(await isLoggedIn(driver))) {
          await driver.get("https://www.linkedin.com/feed/");
          await randomDelay(3000, 3500); // Longer delay to ensure page loads fully
      }

      // Try multiple search box selectors with fallbacks
      for (const selector of searchSelectors) {
          try {
              await driver.wait(until.elementLocated(By.css(selector)), 5000);
              const element = await driver.findElement(By.css(selector));
              await driver.wait(until.elementIsVisible(element), 3000);
              await driver.wait(until.elementIsEnabled(element), 3000);

              searchBox = element;
              foundSelector = selector;
              break;
          } catch (err) {
              // continue to next selector
          }
      }

      if (foundSelector.includes("button")) {
          await searchBox.click();
          await randomDelay(1000, 2000);
          searchBox = await driver.findElement(
              By.css(
                  "input.search-global-typeahead__input, input[aria-label='Search']"
              )
          );
      }

      if (!searchBox) {
          searchBox = await driver.executeScript(`
              return document.querySelector("input.search-global-typeahead__input") || 
                     document.querySelector("input[aria-label='Search']") ||
                     document.querySelector("input[placeholder*='Search']") ||
                     document.querySelector("input.search-box__input") ||
                     Array.from(document.querySelectorAll("input[type='text']"))
                       .find(el => el.getBoundingClientRect().top < 100);
          `);

          if (!searchBox) {
              const encodedName = encodeURIComponent(user.name);
              await driver.get(
                  `https://www.linkedin.com/search/results/people/?keywords=${encodedName}`
              );
              await randomDelay(3000, 5000);
          }
      }

      if (searchBox) {
          await searchBox.sendKeys(Key.CONTROL + "a");
          await searchBox.sendKeys(Key.DELETE);
          await randomDelay(500, 800);

          const name = user.name;
          for (let i = 0; i < name.length; i++) {
              await searchBox.sendKeys(name[i]);
              if (i % 3 === 0) {
                  await randomDelay(50, 150);
              }
          }

          await randomDelay(500, 1000);
          await searchBox.sendKeys(Key.RETURN);
      }

      await randomDelay(7000, 8000);

      // Click the button with HTML content "People"
      try {
          const peopleButton = await driver.findElement(
              By.xpath("//button[normalize-space()='People' or .//*[normalize-space(text())='People']]")
          );
          await driver.wait(until.elementIsVisible(peopleButton), 2000);
          await driver.wait(until.elementIsEnabled(peopleButton), 2000);
          await peopleButton.click();
          await randomDelay(2000, 3000);
      } catch (err) {
          throw err
      }

      let profileLinks = new Set();
      
      for (let page = 0; page < MAX_PAGE_NUMBERS; page++) {
          if (page !== 0) {
              try {
                  const pageNumber = page + 1;
                  const pageButton = await driver.findElement(
                      By.xpath(`//button[.//span[normalize-space(text())='${pageNumber}']]`)
                  );
                  await driver.wait(until.elementIsVisible(pageButton), 2000);
                  await driver.wait(until.elementIsEnabled(pageButton), 2000);
                  await pageButton.click();
                  await randomDelay(3000, 3000);
              } catch (err) {
                  throw err;
              }
          }

          await randomDelay(3000, 5000);

          // Scroll down to load more results
          await driver.executeScript("window.scrollTo(0, document.body.scrollHeight);");
          await randomDelay(3000, 5000);

          const profileSelectors = [
          "a[href*='/in/']",
          "a[href*='/profile/']",
          ".search-results__list a[href*='/in/']",
          ".search-result-item a[href*='/in/']",
          "a.app-aware-link[href*='/in/']",
          ];

          for (const selector of profileSelectors) {
              try {
                  // Wait for at least one element to appear
                  await driver.wait(until.elementsLocated(By.css(selector)), 2000);
                  const elements = await driver.findElements(By.css(selector));
                  for (const el of elements) {
                  const rawUrl = await el.getAttribute("href");
                  if (rawUrl) {
                      const cleanUrl = rawUrl.split("?")[0];
                      profileLinks.add(cleanUrl);
                  }
                  }
              } catch (err) {
                  continue;
              }
          }
      }

      if (profileLinks.size > 0) {
          const profiles = Array.from(profileLinks);
          return profiles;
      }

      return [];
  } catch (error) {
      throw error;
  }
}

// =========================
// Exports
// =========================
export {
  OpenAIRateLimiter,
  computeExperienceYears,
  randomDelay,
  createBrowserSession,
  recoverBrowserSession,
  waitForAuthCodeVerification,
  waitForManualVerification,
  isLoggedIn,
  loginToLinkedIn,
  scrapeLinkedInProfile,
  generateKeywords,
  processUser,
  main,
  getRandomUserAgent,
  humanType,
  humanScroll,
  humanMouseMove,
  logger
};