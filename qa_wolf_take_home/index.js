// EDIT THIS FILE TO COMPLETE ASSIGNMENT QUESTION 1
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');

async function openImage(imagePath) {
  const command = process.platform === 'win32' ? 'start' : 
                 process.platform === 'darwin' ? 'open' : 'xdg-open';
  
  return new Promise((resolve, reject) => {
    exec(`${command} "${imagePath}"`, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function checkImageExists(imagePath) {
  try {
    await fs.access(imagePath);
    return true;
  } catch {
    return false;
  }
}

async function sortHackerNewsArticles() {
  const startTime = Date.now();
  let articlesFetched = 0;
  let pageLoadCount = 0;

  console.log('Starting article collection...wolves are on the prowl');
  
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto("https://news.ycombinator.com/newest");
    console.log('Navigated to Hacker News/newest page');
    
    // Function to convert relative time strings to Date objects
    const parseHackerNewsTime = (timeString) => {
      const now = new Date();
      if (timeString.includes("just now")) return now;
      
      const matches = timeString.match(/(\d+)\s+([a-zA-Z]+)\s+ago/);
      if (!matches) throw new Error(`Wolfs cant tell time? Ouch -1 life => Failed to parse time string: ${timeString}`);
      
      const value = parseInt(matches[1]);
      let unit = matches[2].toLowerCase();
      
      // Convert plural units to singular
      if (unit.endsWith('s')) {
        unit = unit.slice(0, -1);
      }
      
      const timeMultipliers = {
        minute: 60 * 1000,
        hour: 60 * 60 * 1000,
        day: 24 * 60 * 60 * 1000,
        week: 7 * 24 * 60 * 60 * 1000,
        month: 30 * 24 * 60 * 60 * 1000,
        year: 365 * 24 * 60 * 60 * 1000
      };
      
      if (!timeMultipliers[unit]) throw new Error(`Unsupported time unit: ${unit}`);
      
      return new Date(now.getTime() - value * timeMultipliers[unit]);
    };

    // Collect exactly 100 articles...if not the wolves will get me good! 
    let articles = [];
    let moreButtonExists = true;
    const maxIterations = 20;
    let iteration = 0;

    while (articles.length < 100 && moreButtonExists && iteration < maxIterations) {
      pageLoadCount++;
      console.log(`Starting iteration ${iteration + 1}, articles so far: ${articles.length}`);
      
      const currentArticles = await page.$$eval('.athing', elements => 
        elements.map(element => {
          const id = element.getAttribute('id');
          const title = element.querySelector('.titleline a').textContent;
          const subtext = document.getElementById(id).nextElementSibling;
          const ageElement = subtext ? subtext.querySelector('.age a') : null;
          const timeString = ageElement ? ageElement.textContent : null;
          
          return { id, title, timeString };
        })
      );

      const newArticles = currentArticles.filter(article => 
        !articles.some(existing => existing.id === article.id)
      );
      
      articlesFetched += newArticles.length;
      articles = [...articles, ...newArticles];
      
      console.log(`Found ${articles.length} unique articles so far`);
      
      if (articles.length >= 100) {
        break;
      }
      
      try {
        await page.waitForSelector('.morelink', { state: 'visible', timeout: 5000 });
        await page.click('.morelink');
        await page.waitForTimeout(1000);
        console.log('Clicked "More" button...Wolves are on the Move!');
      } catch (error) {
        moreButtonExists = false;
        console.log('No more articles to load...what where are my wolves?🐺');
      }
      
      iteration++;
    }

    articles = articles.slice(0, 100);
    
    if (articles.length !== 100) {
      throw new Error(`Expected exactly 100 articles, found ${articles.length}`);
    }

    const parsedDates = articles.map(article => {
      try {
        return {
          title: article.title,
          date: parseHackerNewsTime(article.timeString)
        };
      } catch (error) {
        console.error(`Wolfs cant tell time? Ouch -1 life => Error parsing time string "${article.timeString}"`, error.message);
        throw error;
      }
    });

    // Sort articles from newest to oldest
    console.log('Sorting articles by date...');
    parsedDates.sort((a, b) => {
      // First compare by date
      const dateComparison = b.date.getTime() - a.date.getTime();
      
      // If dates are equal, maintain original order
      // This preserves the order in which articles appear on the page
      if (dateComparison === 0) {
        console.log('Found articles with same timestamp, preserving original order:', {
          title1: a.title,
          title2: b.title,
          timestamp: a.date
        });
        return 0; // Keep original order for same timestamps
      }
      
      return dateComparison;
    });

    // Verify articles are sorted correctly (only by timestamp)
    for (let i = 1; i < parsedDates.length; i++) {
      const currentDate = parsedDates[i].date.getTime();
      const previousDate = parsedDates[i - 1].date.getTime();
      
      if (currentDate > previousDate) {
        console.error('Articles not sorted correctly:', {
          current: {
            title: parsedDates[i].title,
            date: parsedDates[i].date.toISOString()
          },
          previous: {
            title: parsedDates[i-1].title,
            date: parsedDates[i-1].date.toISOString()
          }
        });
        throw new Error(`Articles are not sorted correctly at index ${i}. "${parsedDates[i].title}" is newer than "${parsedDates[i-1].title}"`);
      }
    }

    console.log('Validation passed🐺: Articles are correctly sorted from newest to oldest.', {
      first_article: parsedDates[0].title,
      first_date: parsedDates[0].date.toISOString(),
      last_article: parsedDates[parsedDates.length - 1].title,
      last_date: parsedDates[parsedDates.length - 1].date.toISOString(),
      total_articles: parsedDates.length
    });

    const executionTime = Date.now() - startTime;
    console.log('Scraping completed successfully', {
      execution_time_ms: executionTime,
      articles_fetched: articlesFetched,
      pages_loaded: pageLoadCount,
      iterations: iteration
    });

  } catch (error) {
    console.error('Scraping failed:', error.message);
  } finally {
    await browser.close();
    console.log('Browser closed');
    
    const imagePath = path.join(__dirname, 'QA_wolfie.png');
    
    if (await checkImageExists(imagePath)) {
      try {
        await openImage(imagePath);
        console.log('QA Wolfie executed successfully! ...wolves howling into the night! 🐺🐺🐺');
      } catch (error) {
        console.error('Failed to open QA Wolfie..status: Its Complicated!:', error.message);
      }
    } else {
      console.warn('QA_wolfie.png not found in project directory..wolfie missing.');
    }
  }
}

// Run the test
sortHackerNewsArticles().catch(error => {
  console.error('Fatal error in main process..wolfie dead.:', error.message);
});