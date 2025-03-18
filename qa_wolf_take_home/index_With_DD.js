//Designed this as I was learning Data Dog functionality at the same time I was learning the Javascript/node.js
//Felt inspired to add trackers for meta data, latency, which was very fun and expanded on the initial ask. 
const { chromium } = require('playwright');
const StatsD = require('hot-shots');
const winston = require('winston');
const { createLogger, format, transports } = require('winston');
const Transport = require('winston-transport');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const https = require('https');
const { datadogLogs } = require('@datadog/browser-logs');
require('dotenv').config();

// Initialize browser logs with validation
if (!process.env.DD_CLIENT_TOKEN) {
  console.warn('Wolfs cries could not be heard...Flawless Fatality! => DD_CLIENT_TOKEN is not set. Browser logs will be disabled.');
} else {
  try {
    datadogLogs.init({
      clientToken: process.env.DD_CLIENT_TOKEN,
      site: process.env.DD_SITE || 'us5.datadoghq.com',
      forwardErrorsToLogs: true,
      sessionSampleRate: 100,
      service: 'hacker-news-scraper',
      env: process.env.NODE_ENV || 'development',
      beforeSend: (log) => {
        // Add additional context to all logs
        log.view = {
          url: 'https://news.ycombinator.com/newest'
        };
        return log;
      },
      // Enable additional features
      trackInteractions: true,
      trackResources: true,
      trackLongTasks: true
    });
    console.log('Wolfs are howling into the night! Datadog Browser SDK initialized successfully');
  } catch (error) {
    console.error('Wolfs cries could not be heard -1 life =>  Failed to initialize Datadog Browser SDK:', error.message);
  }
}

// Initialize Datadog tracer first
const tracer = require('dd-trace').init({
  logInjection: true,
  env: process.env.NODE_ENV || 'development',
  service: 'hacker-news-scraper',
  version: '1.0.0',
  analytics: true,
  // Enable more detailed APM features
  profiling: true,
  runtimeMetrics: true,
  // Sample all traces for development
  sampleRate: 1,
  // Enable distributed tracing
  traceId128BitGenerationEnabled: true
});

// Custom transport for Datadog HTTP intake
class DatadogTransport extends Transport {
  constructor(opts) {
    super(opts);
    // Configure local agent connection
    this.dogstatsd = new StatsD({
      host: 'localhost',
      port: 8125,
      prefix: 'hacker_news.scraper.',
      globalTags: { 
        env: process.env.NODE_ENV || 'development',
        service: 'hacker-news-scraper'
      }
    });
  }

  log(info, callback) {
    try {
      // Send log to local agent
      this.dogstatsd.event(
        'Application Log',
        info.message,
        {
          alert_type: info.level === 'error' ? 'error' : 'info',
          tags: [
            `env:${process.env.NODE_ENV || 'development'}`,
            `service:hacker-news-scraper`,
            `level:${info.level}`
          ]
        }
      );

      // Also log to console for debugging
      console.log(`[${info.level}] ${info.message}`);
      
      callback();
    } catch (error) {
      console.error('Wolfs cries could not be heard -1 life => Error sending log to Datadog agent:', error);
      callback();
    }
  }
}

// Configure Winston logger with Datadog correlation and HTTP transport
const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp(),
    format.json(),
    format.printf(({ timestamp, level, message, ...meta }) => {
      const span = tracer.scope().active();
      const record = {
        timestamp,
        level,
        message,
        ...meta
      };

      if (span) {
        tracer.inject(span.context(), 'log', record);
      }

      return JSON.stringify(record);
    })
  ),
  transports: [
    new transports.File({ 
      filename: path.join(__dirname, 'logs', 'scraper.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.simple()
      )
    }),
    new DatadogTransport()
  ]
});

// Initialize Datadog client with more configuration options
const dogstatsd = new StatsD({
  host: 'localhost',
  port: 8125,
  prefix: 'hacker_news.scraper.',
  globalTags: { 
    env: process.env.NODE_ENV || 'development',
    service: 'hacker-news-scraper'
  },
  errorHandler: (error) => {
    logger.error('StatsD error:', { error: error.message });
  },
  // This helps ensure metrics are sent immediately..We want our data and we want it now! 
  bufferFlushInterval: 1000,
  sampleRate: 1
});

// Add basic service health metric
dogstatsd.gauge('service.health', 1);
logger.info('Service started', { health: 1 });

// Helper function to track timing with tags and logging
const trackTiming = async (metricName, tags = {}, fn) => {
  const startTime = process.hrtime();
  logger.debug(`Starting ${metricName}`, { tags });
  
  try {
    const result = await fn();
    const [seconds, nanoseconds] = process.hrtime(startTime);
    const milliseconds = (seconds * 1000) + (nanoseconds / 1000000);
    
    dogstatsd.timing(metricName, milliseconds, tags);
    logger.debug(`Completed ${metricName}`, { 
      duration_ms: milliseconds,
      tags 
    });
    
    return result;
  } catch (error) {
    logger.error(`Error in ${metricName}`, {
      error: error.message,
      tags
    });
    throw error;
  }
};

// Helper function to increment counters with tags and logging
const incrementMetric = (metric, tags = {}) => {
  dogstatsd.increment(metric, 1, tags);
  logger.debug(`Incremented metric: ${metric}`, { tags });
};

// Helper function to record gauge metrics with logging
const recordGauge = (metric, value, tags = {}) => {
  dogstatsd.gauge(metric, value, tags);
  logger.debug(`Recorded gauge: ${metric}`, { value, tags });
};

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

// Add trace middleware helper
const wrapWithTrace = async (name, tags = {}, fn) => {
  const span = tracer.startSpan(name, {
    tags: {
      ...tags,
      'resource.name': name
    }
  });

  try {
    const result = await tracer.trace(name, 
      { tags: { ...tags, 'resource.name': name } }, 
      async () => await fn()
    );
    span.finish();
    return result;
  } catch (error) {
    span.setTag('error', true);
    span.setTag('error.message', error.message);
    span.setTag('error.stack', error.stack);
    span.finish();
    throw error;
  }
};

// Update sortHackerNewsArticles with detailed tracing
async function sortHackerNewsArticles() {
  return await wrapWithTrace('scraper.run', {}, async () => {
    const startTime = Date.now();
    let articlesFetched = 0;
    let pageLoadCount = 0;

    logger.info('Starting article collection..Wolfs are on the prowl!');
    
    const browser = await wrapWithTrace('browser.launch', {}, async () => 
      await chromium.launch({ headless: false })
    );
    
    const context = await wrapWithTrace('browser.newContext', {}, async () => 
      await browser.newContext()
    );
    
    const page = await wrapWithTrace('browser.newPage', {}, async () => 
      await context.newPage()
    );

    try {
      // Track initial page load with tracing
      await wrapWithTrace('page.initial_load', 
        { url: "https://news.ycombinator.com/newest" }, 
        async () => {
          await page.goto("https://news.ycombinator.com/newest");
          logger.info('Navigated to Hacker News/newest page..Wolves moved forward!');
        }
      );
      
      // Function to convert relative time strings to Date objects
      const parseHackerNewsTime = (timeString) => {
        const now = new Date();
        if (timeString.includes("just now")) return now;
        
        const matches = timeString.match(/(\d+)\s+([a-zA-Z]+)\s+ago/);
        if (!matches) throw new Error(`Wolfs cries could not be heard -1 life => Failed to parse time string: ${timeString}`);
        
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

      // Collect exactly 100 articles with tracing
      let articles = [];
      let moreButtonExists = true;
      const maxIterations = 20;
      let iteration = 0;

      while (articles.length < 100 && moreButtonExists && iteration < maxIterations) {
        await wrapWithTrace('scraper.iteration', 
          { iteration: iteration + 1, articles_count: articles.length },
          async () => {
            pageLoadCount++;
            logger.info(`Starting iteration ${iteration + 1}`, { 
              articles_so_far: articles.length 
            });
            
            // Track article fetching with tracing
            const currentArticles = await wrapWithTrace('articles.fetch',
              { iteration: iteration + 1 },
              async () => {
                return await page.$$eval('.athing', elements => 
                  elements.map(element => {
                    const id = element.getAttribute('id');
                    const title = element.querySelector('.titleline a').textContent;
                    const subtext = document.getElementById(id).nextElementSibling;
                    const ageElement = subtext ? subtext.querySelector('.age a') : null;
                    const timeString = ageElement ? ageElement.textContent : null;
                    
                    return { id, title, timeString };
                  })
                );
              }
            );

            // Track article processing with enhanced logging
            const newArticlesCount = currentArticles.filter(article => 
              !articles.some(existing => existing.id === article.id)
            ).length;
            
            articlesFetched += newArticlesCount;
            
            incrementMetric('articles.found_per_page', { 
              count: newArticlesCount,
              iteration: iteration + 1 
            });
            
            logger.info('Processed new articles', {
              new_count: newArticlesCount,
              total_count: articles.length,
              iteration: iteration + 1
            });
            
            incrementMetric('articles.duplicates', { 
              count: currentArticles.length - newArticlesCount 
            });
            
            // Add new articles to the list
            const existingIds = articles.map(a => a.id);
            const newArticles = currentArticles.filter(article => !existingIds.includes(article.id));
            articles = [...articles, ...newArticles];
            
            logger.info(`Found ${articles.length} unique articles so far`);
            
            if (articles.length >= 100) {
              incrementMetric('articles.target_reached');
              return;
            }
            
            // Click "More" button
            try {
              await wrapWithTrace('more_button.click', 
                { iteration: iteration + 1 }, 
                async () => {
                  await page.waitForSelector('.morelink', { state: 'visible', timeout: 5000 });
                  await page.click('.morelink');
                  await page.waitForTimeout(1000);
                }
              );
              
              moreButtonExists = true;
              logger.info('Clicked "More" button');
            } catch (error) {
              incrementMetric('more_button.error', { 
                error_type: error.name 
              });
              moreButtonExists = false;
              logger.info('No more articles to load.');
              return;
            }
          }
        );
        iteration++;
      }

      // Process results with tracing
      await wrapWithTrace('articles.process', 
        { articles_count: articles.length },
        async () => {
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
              logger.error(`Error parsing time string(Wolves cant read...) "${article.timeString}"`, { 
                error: error.message,
                article_title: article.title 
              });
              throw error;
            }
          });

          // Sort articles from newest to oldest
          logger.info('Sorting articles by date...');
          parsedDates.sort((a, b) => {
            // First compare by date
            const dateComparison = b.date.getTime() - a.date.getTime();
            
            // If dates are equal, sort alphabetically by title 
            if (dateComparison === 0) {
              logger.debug('Found articles with identical timestamps (Well, Well, Well...There can only be one highlander!)', {
                title1: a.title,
                title2: b.title,
                timestamp: a.date
              });
              return a.title.localeCompare(b.title);
            }
            
            return dateComparison;
          });
          
          logger.info('Articles sorted successfully', {
            newest_article: parsedDates[0].title,
            newest_date: parsedDates[0].date,
            oldest_article: parsedDates[parsedDates.length - 1].title,
            oldest_date: parsedDates[parsedDates.length - 1].date,
            total_articles: parsedDates.length
          });

          // Verify articles are sorted from newest to oldest
          for (let i = 1; i < parsedDates.length; i++) {
            const currentDate = parsedDates[i].date.getTime();
            const previousDate = parsedDates[i - 1].date.getTime();
            
            if (currentDate > previousDate || 
               (currentDate === previousDate && 
                parsedDates[i].title.localeCompare(parsedDates[i - 1].title) < 0)) {
              logger.error('Articles not sorted correctly', {
                index: i,
                current_article: parsedDates[i].title,
                current_date: parsedDates[i].date,
                previous_article: parsedDates[i-1].title,
                previous_date: parsedDates[i-1].date,
                same_timestamp: currentDate === previousDate
              });
              throw new Error(
                currentDate === previousDate ?
                `Articles with same timestamp not sorted alphabetically at index ${i}. "${parsedDates[i].title}" should come before "${parsedDates[i-1].title}"` :
                `Articles are not sorted correctly at index ${i}. "${parsedDates[i].title}" is newer than "${parsedDates[i-1].title}"`
              );
            }
          }

          logger.info('Validation passed🐺: Articles are correctly sorted from newest to oldest', {
            first_article: parsedDates[0].title,
            last_article: parsedDates[parsedDates.length - 1].title,
            time_span_hours: (parsedDates[0].date.getTime() - parsedDates[parsedDates.length - 1].date.getTime()) / (1000 * 60 * 60)
          });

          // Record metrics about the sorting
          recordGauge('articles.time_span_hours', 
            (parsedDates[0].date.getTime() - parsedDates[parsedDates.length - 1].date.getTime()) / (1000 * 60 * 60)
          );
          recordGauge('articles.newest_age_minutes',
            (new Date().getTime() - parsedDates[0].date.getTime()) / (1000 * 60)
          );
          recordGauge('articles.oldest_age_minutes',
            (new Date().getTime() - parsedDates[parsedDates.length - 1].date.getTime()) / (1000 * 60)
          );
        }
      );

      // Track metrics with tracing context
      const executionTime = Date.now() - startTime;
      await wrapWithTrace('metrics.record', 
        { execution_time: executionTime },
        async () => {
          recordGauge('execution.time', executionTime);
          recordGauge('articles.total_fetched', articlesFetched);
          recordGauge('pages.loaded', pageLoadCount);
          recordGauge('execution.iterations', iteration);
          recordGauge('articles.per_second', articles.length / (executionTime / 1000));
        }
      );

      logger.info('Scraping completed successfully', {
        execution_time_ms: executionTime,
        articles_fetched: articlesFetched,
        pages_loaded: pageLoadCount,
        iterations: iteration
      });
    } catch (error) {
      logger.error('Scraping failed', {
        error: error.message,
        articles_fetched: articlesFetched,
        execution_time_ms: Date.now() - startTime
      });
      
      incrementMetric('scraper.error', {
        error_type: error.name,
        articles_fetched: articlesFetched.toString()
      });
    } finally {
      await wrapWithTrace('cleanup', {}, async () => {
        await browser.close();
        dogstatsd.close();
        logger.info('Browser closed and metrics flushed');
        
        // Display wolfie emoji :P because why not?
        const imagePath = path.join(__dirname, 'QA_wolfie.png');
        
        if (await checkImageExists(imagePath)) {
          try {
            await openImage(imagePath);
            logger.info('QA Wolfie executed successfully...wolves howling into the night! 🐺');
          } catch (error) {
            logger.error('Failed to open QA Wolfie', { error: error.message });
          }
        } else {
          logger.warn('QA_wolfie.png not found in project directory');
        }
      });
    }
  });
}

// Run the test with enhanced error logging
sortHackerNewsArticles().catch(error => {
  logger.error('Fatal error in main process..yep we dead', {
    error: error.message,
    stack: error.stack
  });
  
  incrementMetric('scraper.fatal_error..yep we dead', {
    error_type: error.name
  });
});