#!/usr/bin/env node

const express = require('express');
const { program } = require('commander');
const path = require('path');
const chalk = require('chalk');
const cors = require('cors');
const fs = require('fs');
const readline = require('readline');
const ApiMocker = require('../lib/index');

// Version from package.json
const packageJson = require('../package.json');

// Configure CLI options
program
  .name('api-mocker')
  .description('Simple directory-based API mock server')
  .version(packageJson.version)
  .option('-p, --port <number>', 'Port to run the server on', '3000')
  .option('-d, --directory <path>', 'Directory containing mock data', 'mocks')
  .option('-D, --delay <number>', 'Delay in milliseconds for all responses', '0')
  .option('--cors', 'Enable CORS for all routes', false)
  .option('--init', 'Initialize a new mocks directory with examples', false)
  .option('--interactive', 'Enable interactive CLI mode', true)
  .parse(process.argv);

const options = program.opts();

// Handle initialization
if (options.init) {
  const targetDir = path.join(process.cwd(), options.directory);
  const sourceMocksDir = path.join(__dirname, '../examples/mocks');

  // Copy all files from sourceMocksDir to targetDir
  if (fs.existsSync(sourceMocksDir)) {
    fs.cpSync(sourceMocksDir, targetDir, { recursive: true });
    console.log(chalk.green(`Copied example mocks from: ${sourceMocksDir}`));
  } else {
    console.log(chalk.red(`Source mocks directory not found: ${sourceMocksDir}`));
  }

  console.log(chalk.green('\nMock API directory initialized with example files!'));
  console.log(chalk.yellow(`\nStart the server with: npx @arkarmintun/api-mocker --directory ${options.directory}`));
  process.exit(0);
}

// Create Express app
const app = express();

// Enable CORS if requested
if (options.cors) {
  app.use(cors());
  console.log(chalk.blue('CORS enabled for all routes'));
}

// Parse JSON request bodies
app.use(express.json());

// Parse URL-encoded form data
app.use(express.urlencoded({ extended: true }));

// Get absolute path to mocks directory
const mocksDirectory = path.resolve(process.cwd(), options.directory);

// Check if directory exists
if (!fs.existsSync(mocksDirectory)) {
  console.error(chalk.red(`Error: Directory not found: ${mocksDirectory}`));
  console.log(chalk.yellow(`\nTip: Initialize a new mocks directory with: @arkarmintun/api-mocker --init`));
  process.exit(1);
}

// Create custom logger
const logger = (message) => {
  console.log(chalk.blue(`[${new Date().toISOString()}] ${message}`));
};

// Create API mocker
const apiMocker = new ApiMocker({
  directory: mocksDirectory,
  delay: parseInt(options.delay, 10),
  errorRate: parseFloat(options.errorRate),
  logger,
});

// Setup for controlling errors via CLI
let nextErrorCode = null;
let errorForPath = null;

// Request logger middleware
app.use((req, res, next) => {
  logger(`${req.method} ${req.path}`);
  next();
});

// Middleware to apply next error if set
app.use((req, res, next) => {
  if (nextErrorCode && (!errorForPath || req.path.includes(errorForPath))) {
    console.log(chalk.yellow(`Forcing error ${nextErrorCode} for request: ${req.method} ${req.path}`));
    req._forceError = nextErrorCode;
    nextErrorCode = null;
    errorForPath = null;
  }
  next();
});

// Use API mocker middleware
app.use(apiMocker.middleware());

// Fallback for non-mocked routes
app.use((req, res) => {
  logger(`No mock found for: ${req.method} ${req.path}`);
  res.status(404).json({
    error: 'Endpoint not found',
    message: `No mock defined for ${req.method} ${req.path}`,
  });
});

// Start server
const PORT = parseInt(options.port, 10);
const server = app.listen(PORT, () => {
  console.log(chalk.green('┌───────────────────────────────────────────────┐'));
  console.log(chalk.green('│            Simple API Mocker Server           │'));
  console.log(chalk.green('└───────────────────────────────────────────────┘'));
  console.log(chalk.white(`\n✓ Server running on: ${chalk.cyan(`http://localhost:${PORT}`)}`));
  console.log(chalk.white(`✓ Mock data directory: ${chalk.cyan(mocksDirectory)}`));
  console.log(chalk.white(`✓ Response delay: ${chalk.cyan(options.delay)}ms`));

  // Display available routes
  const routes = apiMocker.listRoutes();
  if (routes.length > 0) {
    console.log(chalk.green('\nAvailable mock endpoints:'));

    routes.forEach((route) => {
      // Format the endpoint for display (replace [param] with :param)
      const displayPath = route.path.replace(/\[(\w+)\]/g, ':$1');
      const methodColor =
        {
          GET: chalk.green,
          POST: chalk.yellow,
          PUT: chalk.blue,
          DELETE: chalk.red,
          PATCH: chalk.magenta,
        }[route.method] || chalk.white;

      console.log(`  ${methodColor(route.method.padEnd(6))} ${chalk.cyan(displayPath)}`);
    });
  } else {
    console.log(chalk.yellow('\nNo mock endpoints found.'));
    console.log(chalk.yellow(`Tip: Initialize example mocks with: npx @arkarmintun/api-mocker --init`));
  }

  if (options.interactive) {
    setupInteractiveCLI();
  } else {
    console.log(chalk.white('\nPress Ctrl+C to stop the server'));
  }
});

/**
 * Setup interactive CLI mode
 */
function setupInteractiveCLI() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('api-mocker> '),
  });

  // Display available commands
  console.log(chalk.green('\nInteractive mode enabled. Available commands:'));
  console.log(chalk.cyan('  error <code>           ') + 'Trigger error for next request');
  console.log(chalk.cyan('  error <code> <path>    ') + 'Trigger error for next request to path');
  console.log(chalk.cyan('  delay <ms>             ') + 'Set response delay');
  console.log(chalk.cyan('  routes                 ') + 'List available routes');
  console.log(chalk.cyan('  errors                 ') + 'List available error types');
  console.log(chalk.cyan('  help                   ') + 'Show available commands');
  console.log(chalk.cyan('  exit                   ') + 'Stop the server and exit');

  rl.prompt();

  rl.on('line', (line) => {
    const args = line.trim().split(' ');
    const command = args[0].toLowerCase();

    switch (command) {
      case 'error':
        if (args.length < 2) {
          console.log(chalk.red('Error code required: error <code> [path]'));
        } else {
          nextErrorCode = args[1];
          errorForPath = args[2] || null;
          console.log(
            chalk.yellow(`Next request${errorForPath ? ` to ${errorForPath}` : ''} will return ${nextErrorCode} error`)
          );
        }
        break;

      case 'delay':
        if (args.length < 2) {
          console.log(chalk.red('Delay in ms required: delay <ms>'));
        } else {
          const newDelay = parseInt(args[1], 10);
          if (isNaN(newDelay)) {
            console.log(chalk.red('Invalid delay value. Must be a number.'));
          } else {
            apiMocker.delay = newDelay;
            console.log(chalk.yellow(`Response delay set to ${newDelay}ms`));
          }
        }
        break;

      case 'routes':
        const routes = apiMocker.listRoutes();
        console.log(chalk.green('\nAvailable mock endpoints:'));
        routes.forEach((route) => {
          const displayPath = route.path.replace(/\[(\w+)\]/g, ':$1');
          const methodColor =
            {
              GET: chalk.green,
              POST: chalk.yellow,
              PUT: chalk.blue,
              DELETE: chalk.red,
              PATCH: chalk.magenta,
            }[route.method] || chalk.white;

          console.log(`  ${methodColor(route.method.padEnd(6))} ${chalk.cyan(displayPath)}`);
        });
        break;

      case 'errors':
        console.log(chalk.green('\nAvailable error types:'));
        console.log(chalk.cyan('  400') + ' - Bad Request');
        console.log(chalk.cyan('  401') + ' - Unauthorized');
        console.log(chalk.cyan('  403') + ' - Forbidden');
        console.log(chalk.cyan('  404') + ' - Not Found');
        // console.log(chalk.cyan('  409') + ' - Conflict');
        // console.log(chalk.cyan('  429') + ' - Too Many Requests');
        console.log(chalk.cyan('  500') + ' - Internal Server Error');
        // console.log(chalk.cyan('  503') + ' - Service Unavailable');
        console.log(chalk.cyan('\nCustom error scenarios:'));

        // List custom error scenarios from error files
        const errorScenarios = apiMocker.listErrorScenarios();
        errorScenarios.forEach((scenario) => {
          console.log(`  ${chalk.cyan(scenario.name)} - ${scenario.description || 'Custom error'}`);
        });
        break;

      case 'help':
        console.log(chalk.green('\nAvailable commands:'));
        console.log(chalk.cyan('  error <code>           ') + 'Trigger error for next request');
        console.log(chalk.cyan('  error <code> <path>    ') + 'Trigger error for next request to path');
        console.log(chalk.cyan('  delay <ms>             ') + 'Set response delay');
        console.log(chalk.cyan('  routes                 ') + 'List available routes');
        console.log(chalk.cyan('  errors                 ') + 'List available error types');
        console.log(chalk.cyan('  help                   ') + 'Show available commands');
        console.log(chalk.cyan('  exit                   ') + 'Stop the server and exit');
        break;

      case 'exit':
        console.log(chalk.green('Stopping server...'));
        rl.close();
        server.close(() => {
          process.exit(0);
        });
        break;

      case '':
        // Empty line, do nothing
        break;

      default:
        console.log(chalk.red(`Unknown command: ${command}`));
        console.log(chalk.yellow('Type "help" for available commands'));
    }

    rl.prompt();
  }).on('close', () => {
    console.log(chalk.green('Stopping server...'));
    server.close(() => {
      process.exit(0);
    });
  });
}
