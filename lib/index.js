const fs = require('fs');
const path = require('path');

class ApiMocker {
  constructor(options = {}) {
    this.mockDirectory = options.directory || path.join(process.cwd(), 'mocks');
    this.errorDirectory = path.join(this.mockDirectory, '_errors');
    this.delay = options.delay || 0;
    this.errorRate = options.errorRate || 0; // Probability of returning an error (0-1)
    this.logger = options.logger || console.log;
  }

  /**
   * Parse path parameters from a request path and directory path
   */
  parsePathParams(requestPath, mockDirPath) {
    // Convert directory path to regex pattern
    const dirParts = mockDirPath.split('/').filter(Boolean);
    const requestParts = requestPath.split('/').filter(Boolean);

    // Quick length check
    if (dirParts.length !== requestParts.length) {
      return null;
    }

    const params = {};

    // Match each path segment
    for (let i = 0; i < dirParts.length; i++) {
      const dirPart = dirParts[i];
      const requestPart = requestParts[i];

      // Check if this is a parameter segment [param]
      if (dirPart.startsWith('[') && dirPart.endsWith(']')) {
        // Extract parameter name without brackets
        const paramName = dirPart.substring(1, dirPart.length - 1);
        params[paramName] = requestPart;
      }
      // If not a parameter, it must match exactly
      else if (dirPart !== requestPart) {
        return null;
      }
    }

    return params;
  }

  /**
   * Find a mock file that matches the request path and method
   * @param {string} requestPath - The incoming request path
   * @param {string} method - The HTTP method (GET, POST, etc.)
   * @returns {string|null} - The mock file path if found, null otherwise
   */
  findMock(requestPath, method = 'GET') {
    const trimmedPath = requestPath.endsWith('/') ? requestPath.slice(0, -1) : requestPath;

    // Normalize path to always start with /
    const normalizedPath = trimmedPath.startsWith('/') ? trimmedPath : '/' + trimmedPath;

    // First try exact match (check if file exists)
    const exactPath = path.join(this.mockDirectory, normalizedPath);

    // Method-specific file (e.g., GET.json, POST.json)
    if (fs.existsSync(path.join(exactPath, `${method}.json`))) {
      return path.join(exactPath, `${method}.json`);
    }

    // Fallback to method-agnostic file (for backwards compatibility)
    if (fs.existsSync(exactPath + '.json')) {
      return exactPath + '.json';
    }

    // For directories that represent the endpoint
    if (fs.existsSync(path.join(exactPath, 'index.json'))) {
      return path.join(exactPath, 'index.json');
    }

    // For backwards compatibility - index.json is equivalent to GET.json
    if (method === 'GET' && fs.existsSync(path.join(exactPath, 'index.json'))) {
      return path.join(exactPath, 'index.json');
    }

    // If no exact match, try to match with path parameters
    return this.findMockWithParams(normalizedPath, method);
  }

  /**
   * Find a mock file with path parameters
   * @param {string} requestPath - The incoming request path
   * @param {string} method - The HTTP method
   * @returns {string|null} - The mock file path if found, null otherwise
   */
  findMockWithParams(requestPath, method) {
    // Get all possible mock paths by walking the directory
    const mockPaths = this.getAllMockPaths();

    // Try to match against each possible path
    for (const mockPath of mockPaths) {
      // Skip if the file doesn't match the method
      const filename = path.basename(mockPath);

      // Check if this is a method-specific file
      if (
        filename !== `${method}.json` &&
        filename !== 'index.json' &&
        filename !== path.basename(requestPath) + '.json'
      ) {
        continue;
      }

      // Convert to a relative path for matching
      const relPath = path.relative(this.mockDirectory, mockPath);
      const dirPath = path.dirname(relPath);
      const mockDirPath = dirPath === '.' ? '/' : '/' + dirPath.replace(/\\/g, '/');

      // Check if this is a potential match based on path segments
      const params = this.parsePathParams(requestPath, mockDirPath);

      if (params !== null) {
        return mockPath;
      }
    }

    return null;
  }

  /**
   * Get all possible mock paths in the mocks directory
   * @returns {string[]} - Array of mock file paths
   */
  getAllMockPaths() {
    const results = [];

    function walkDir(currentPath) {
      if (!fs.existsSync(currentPath)) {
        return;
      }

      const files = fs.readdirSync(currentPath, { withFileTypes: true });

      files.forEach((file) => {
        const filePath = path.join(currentPath, file.name);

        if (file.isDirectory()) {
          // Skip _errors directory
          if (file.name !== '_errors' && file.name !== 'errors') {
            walkDir(filePath);
          }
        } else if (file.name.endsWith('.json')) {
          results.push(filePath);
        }
      });
    }

    walkDir(this.mockDirectory);
    return results;
  }

  /**
   * Get mock response for a given path and method
   * @param {string} requestPath - The API path to match
   * @param {string} method - The HTTP method (GET, POST, etc.)
   * @param {object} requestBody - The request body for POST/PUT requests
   * @param {object} query - The query parameters
   * @param {object} headers - The request headers
   * @returns {Promise<object>} - The mock response
   */
  async getMockResponse(requestPath, method = 'GET', requestBody = null, query = {}, headers = {}, forceError) {
    // Check for error query parameter for explicit error testing
    if (forceError) {
      return this.getErrorResponse(forceError, requestPath, method);
    }

    // Check for specific error scenarios in request
    const specificError = await this.checkForSpecificError(requestPath, method, requestBody, query, headers);
    if (specificError) {
      return specificError;
    }

    // Randomly generate errors based on errorRate
    if (this.errorRate > 0 && Math.random() < this.errorRate) {
      const errorCodes = [400, 401, 403, 404, 500];
      const randomErrorCode = errorCodes[Math.floor(Math.random() * errorCodes.length)];
      return this.getErrorResponse(randomErrorCode, requestPath, method);
    }

    const mockPath = this.findMock(requestPath, method);

    if (!mockPath) {
      // No mock found - return 404 error
      return this.getErrorResponse(404, requestPath, method);
    }

    try {
      // Read the JSON file
      const fileContent = fs.readFileSync(mockPath, 'utf8');
      let response = JSON.parse(fileContent);

      // Extract special directives
      const statusCode = response._statusCode || 200;
      const headers = response._headers || {};

      // Remove special directives from response
      delete response._statusCode;
      delete response._headers;

      // Process requestBody if POST/PUT with _echo or _merge directives
      if (requestBody && (method === 'POST' || method === 'PUT')) {
        if (response._echo === true) {
          // Return the request body as the response
          delete response._echo;
          response = { ...response, ...requestBody };
        } else if (response._merge === true) {
          // Merge request body with the mock response
          delete response._merge;
          response = { ...response, ...requestBody };
        }
      }

      // Simulate network delay
      if (this.delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delay));
      }

      this.logger(`Mock response for ${method} ${requestPath} ready from ${mockPath}`);
      return {
        body: response,
        statusCode: statusCode,
        headers: headers,
      };
    } catch (error) {
      this.logger(`Error loading mock response: ${error.message}`);
      return this.getErrorResponse(500, requestPath, method);
    }
  }

  /**
   * Check for specific error scenarios based on request
   * @param {string} requestPath - The request path
   * @param {string} method - The HTTP method
   * @param {object} body - Request body
   * @param {object} query - Query parameters
   * @param {object} headers - Request headers
   * @returns {object|null} - Error response or null
   */
  async checkForSpecificError(requestPath, method, body, query, headers) {
    // Find path to potential errors directory
    const trimmedPath = requestPath.endsWith('/') ? requestPath.slice(0, -1) : requestPath;

    const normalizedPath = trimmedPath.startsWith('/') ? trimmedPath : '/' + trimmedPath;

    const pathParts = normalizedPath.split('/').filter(Boolean);

    // Handle paths with dynamic segments
    let errorDir = path.join(this.mockDirectory);
    for (const part of pathParts) {
      // For folders with dynamic parameters
      const files = fs.existsSync(errorDir) ? fs.readdirSync(errorDir) : [];
      const dynamicFolder = files.find((f) => f.startsWith('[') && f.endsWith(']'));

      if (dynamicFolder) {
        errorDir = path.join(errorDir, dynamicFolder);
      } else {
        errorDir = path.join(errorDir, part);
      }
    }

    // Check for errors directory
    const errorsDir = path.join(errorDir, 'errors');
    if (!fs.existsSync(errorsDir)) {
      return null;
    }

    // Look for error files matching this method
    const errorFiles = fs.readdirSync(errorsDir).filter((f) => f.startsWith(`${method}_`) && f.endsWith('.json'));

    // For each potential error file, check if it applies to this request
    for (const errorFile of errorFiles) {
      // Extract the error scenario from the filename
      // e.g., POST_existing_email.json => existing_email
      const scenario = errorFile.substring(method.length + 1, errorFile.length - 5);

      // Read the error file
      const errorPath = path.join(errorsDir, errorFile);
      const errorContent = fs.readFileSync(errorPath, 'utf8');
      const errorData = JSON.parse(errorContent);

      // Check if this error applies based on its conditions
      if (this.errorApplies(errorData, scenario, body, query, headers)) {
        // This error applies to the current request
        const statusCode = errorData._statusCode || 400;
        const responseHeaders = errorData._headers || {};

        // Remove special directives
        delete errorData._statusCode;
        delete errorData._headers;
        delete errorData._conditions;

        return {
          body: errorData,
          statusCode: statusCode,
          headers: responseHeaders,
        };
      }
    }

    return null;
  }

  /**
   * Check if an error applies to the current request
   * @param {object} errorData - The error response data
   * @param {string} scenario - The error scenario name
   * @param {object} body - Request body
   * @param {object} query - Query parameters
   * @param {object} headers - Request headers
   * @returns {boolean} - True if the error applies
   */
  errorApplies(errorData, scenario, body, query, headers) {
    // If there are explicit conditions defined in the error file
    if (errorData._conditions) {
      return this.evaluateConditions(errorData._conditions, body, query, headers);
    }

    // Otherwise, use common scenarios based on filename
    switch (scenario) {
      case 'existing_email':
        return body && body.email && body.email.includes('existing');

      case 'invalid_input':
        return body && (body.name === '' || body.email === '' || (body.password && body.password.length < 6));

      case 'unauthorized':
        return !headers.authorization || !headers.authorization.startsWith('Bearer ');

      case 'forbidden':
        return headers.role === 'guest';

      // Add more common scenarios as needed

      default:
        // For custom scenarios, we'd need more specific logic
        return false;
    }
  }

  /**
   * Evaluate conditions against request data
   * @param {Array<object>} conditions - Conditions to evaluate
   * @param {object} body - Request body
   * @param {object} query - Query parameters
   * @param {object} headers - Request headers
   * @returns {boolean} - True if any condition matches
   */
  evaluateConditions(conditions, body, query, headers) {
    for (const condition of conditions) {
      let matches = true;

      if (condition.body && body) {
        for (const [key, value] of Object.entries(condition.body)) {
          if (body[key] !== value) {
            matches = false;
            break;
          }
        }
      }

      if (matches && condition.query && query) {
        for (const [key, value] of Object.entries(condition.query)) {
          if (query[key] !== value) {
            matches = false;
            break;
          }
        }
      }

      if (matches && condition.headers && headers) {
        for (const [key, value] of Object.entries(condition.headers)) {
          if (headers[key] !== value) {
            matches = false;
            break;
          }
        }
      }

      if (matches) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get an error response
   * @param {number|string} errorCode - HTTP error code or name
   * @param {string} requestPath - Original request path
   * @param {string} method - HTTP method
   * @returns {object} - Error response
   */
  async getErrorResponse(errorCode, requestPath, method) {
    // Convert named errors to codes
    const errorMap = {
      badrequest: 400,
      unauthorized: 401,
      forbidden: 403,
      notfound: 404,
      conflict: 409,
      servererror: 500,
    };

    let statusCode = parseInt(errorCode, 10);
    if (isNaN(statusCode)) {
      statusCode = errorMap[errorCode.toLowerCase()] || 500;
    }

    console.log(`STATUS Code: ${statusCode} ${errorCode}, ${requestPath}, ${method}`);

    // Look for a specific error file
    const errorFilePath = path.join(this.errorDirectory, `${statusCode}.json`);

    if (fs.existsSync(errorFilePath)) {
      try {
        const fileContent = fs.readFileSync(errorFilePath, 'utf8');
        const errorTemplate = JSON.parse(fileContent);

        // Allow for customization with request details
        let errorBody = JSON.parse(
          JSON.stringify(errorTemplate)
            .replace(/\{path\}/g, requestPath)
            .replace(/\{method\}/g, method)
        );

        // Simulate network delay
        if (this.delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.delay));
        }

        return {
          body: errorBody,
          statusCode: statusCode,
          headers: errorTemplate._headers || {},
        };
      } catch (error) {
        // Fallback to default error
      }
    }

    // Fallback default error responses
    const defaultErrors = {
      400: { error: 'Bad Request', message: 'The request was malformed or contains invalid parameters.' },
      401: { error: 'Unauthorized', message: 'Authentication is required to access this resource.' },
      403: { error: 'Forbidden', message: 'You do not have permission to access this resource.' },
      404: { error: 'Not Found', message: `Resource at ${method} ${requestPath} was not found.` },
      409: { error: 'Conflict', message: 'The request conflicts with the current state of the server.' },
      429: { error: 'Too Many Requests', message: 'Rate limit exceeded. Please try again later.' },
      500: { error: 'Internal Server Error', message: 'An unexpected error occurred while processing the request.' },
      503: { error: 'Service Unavailable', message: 'The service is currently unavailable. Please try again later.' },
    };

    return {
      body: defaultErrors[statusCode] || defaultErrors[500],
      statusCode: statusCode,
      headers: {},
    };
  }

  /**
   * List all available routes with their methods
   * @returns {Array<object>} - Array of route objects
   */
  listRoutes() {
    const routes = [];
    const methodRegex = /^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\.json$/;

    function walkDir(currentPath, basePath = '') {
      if (!fs.existsSync(currentPath)) {
        return;
      }

      const files = fs.readdirSync(currentPath, { withFileTypes: true });

      // First, identify if this directory has method files
      const methodFiles = files.filter((file) => !file.isDirectory() && methodRegex.test(file.name));

      // If we have method files, add them as routes
      if (methodFiles.length > 0) {
        methodFiles.forEach((file) => {
          const method = file.name.split('.')[0];
          routes.push({
            method,
            path: basePath,
          });
        });
      }

      // Check for index.json (implicit GET)
      const hasIndex = files.some((file) => !file.isDirectory() && file.name === 'index.json');
      if (hasIndex) {
        routes.push({
          method: 'GET',
          path: basePath,
        });
      }

      // Process subdirectories
      files.forEach((file) => {
        if (file.isDirectory() && file.name !== 'errors' && file.name !== '_errors') {
          const dirName = file.name;
          // Skip if the directory is a method name
          if (!methodRegex.test(dirName + '.json')) {
            const newBasePath = basePath + '/' + dirName;
            walkDir(path.join(currentPath, dirName), newBasePath);
          }
        }
      });
    }

    walkDir(this.mockDirectory, '');

    return routes;
  }

  /**
   * List available error scenarios
   * @returns {Array<object>} - Array of error scenarios
   */
  listErrorScenarios() {
    const scenarios = [];

    // Check global errors directory
    const globalErrorsDir = path.join(this.mockDirectory, '_errors');
    if (fs.existsSync(globalErrorsDir)) {
      const errorFiles = fs.readdirSync(globalErrorsDir).filter((f) => f.endsWith('.json'));
      errorFiles.forEach((file) => {
        const code = file.replace('.json', '');
        scenarios.push({
          name: code,
          description: `Global ${code} error`,
        });
      });
    }

    // Function to scan for error directories
    const scanForErrors = (dirPath, basePath = '') => {
      if (!fs.existsSync(dirPath)) return;

      const items = fs.readdirSync(dirPath, { withFileTypes: true });

      // Check for errors directory
      const errorsDir = items.find((item) => item.isDirectory() && item.name === 'errors');
      if (errorsDir) {
        const errorsDirPath = path.join(dirPath, 'errors');
        const errorFiles = fs.readdirSync(errorsDirPath).filter((f) => f.endsWith('.json'));

        errorFiles.forEach((file) => {
          const parts = file.replace('.json', '').split('_');
          const method = parts[0];
          const scenario = parts.slice(1).join('_');

          scenarios.push({
            name: `${scenario}`,
            description: `${method} ${basePath} - ${scenario.replace(/_/g, ' ')}`,
          });
        });
      }

      // Process subdirectories
      items.forEach((item) => {
        if (item.isDirectory() && item.name !== 'errors') {
          const newBasePath = basePath + '/' + item.name;
          scanForErrors(path.join(dirPath, item.name), newBasePath);
        }
      });
    };

    // Scan for errors starting from the root
    scanForErrors(this.mockDirectory);

    return scenarios;
  }

  /**
   * Create Express middleware
   */
  middleware() {
    return async (req, res, next) => {
      try {
        const response = await this.getMockResponse(
          req.path,
          req.method,
          req.body,
          req.query,
          req.headers,
          req._forceError
        );

        // Set custom headers if specified
        if (response.headers) {
          Object.entries(response.headers).forEach(([key, value]) => {
            res.set(key, value);
          });
        }

        // Send response with appropriate status code
        res.status(response.statusCode).json(response.body);
      } catch (error) {
        // This should rarely happen since we handle most errors in getMockResponse
        res.status(500).json({
          error: 'Server Error',
          message: 'An unexpected error occurred in the mock server.',
          details: error.message,
        });
      }
    };
  }
}

module.exports = ApiMocker;
