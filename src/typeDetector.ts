/**
 * Type detector - listens to HTTP trace events and generates TypeScript types
 */

import {tracing, HttpTraceEvent} from './tracing.js';
import {inferType, mergeTypes, InferredType, generateInterfaceFile} from './typeInference.js';
import path from 'path';
import fs from 'fs/promises';

/**
 * Collected response data for a single HTTP method
 */
interface CollectedResponse {
  className: string;
  methodName: string;
  responses: any[]; // JSON response bodies
  requestParams: Array<{ params: string; timestamp: string }>;
}

/**
 * Type detector class - manages HTTP response collection and type generation
 */
export class TypeDetector {
  private responses: Map<string, CollectedResponse> = new Map();
  private listener: ((event: HttpTraceEvent) => void) | null = null;
  private sourceFileMap: Map<string, string> = new Map(); // className -> source file path

  /**
   * Start listening to HTTP trace events
   */
  start(): void {
    if (this.listener) {
      console.warn('TypeDetector already started');
      return;
    }

    this.listener = (event: HttpTraceEvent) => {
      // Only process successful HTTP complete events with JSON bodies
      if (event.eventType !== 'http.request.complete' || !event.body) {
        return;
      }

      // Only process if className and methodName are present
      if (!event.className || !event.methodName) {
        return;
      }

      // Only process JSON responses (skip text/binary)
      if (typeof event.body !== 'object') {
        return;
      }

      const key = `${event.className}::${event.methodName}`;

      // Get or create collection for this method
      let collection = this.responses.get(key);
      if (!collection) {
        collection = {
          className: event.className,
          methodName: event.methodName,
          responses: [],
          requestParams: [],
        };
        this.responses.set(key, collection);
      }

      // Add response body
      collection.responses.push(event.body);

      // Add request parameters (simplified - just show HTTP method and path)
      const timestamp = new Date(event.timestamp).toISOString();
      const urlObj = new URL(event.url);
      const params = `${event.method} ${urlObj.pathname}${urlObj.search}`;
      collection.requestParams.push({ params, timestamp });
    };

    tracing.onHttpComplete(this.listener);
    console.log('🔍 Type detection enabled - capturing HTTP responses');
  }

  /**
   * Stop listening to HTTP trace events
   */
  stop(): void {
    if (this.listener) {
      tracing.removeListener('http.request.complete', this.listener);
      this.listener = null;
    }
  }

  /**
   * Register a source file path for a class
   */
  registerSourceFile(className: string, sourceFilePath: string): void {
    this.sourceFileMap.set(className, sourceFilePath);
  }

  /**
   * Get collected response count
   */
  getCollectedCount(): number {
    return this.responses.size;
  }

  /**
   * Get summary of collected responses
   */
  getSummary(): Array<{ key: string; count: number }> {
    return Array.from(this.responses.entries()).map(([key, data]) => ({
      key,
      count: data.responses.length,
    }));
  }

  /**
   * Generate TypeScript type files for all collected responses
   */
  async generateTypeFiles(): Promise<Array<{ filePath: string; success: boolean; error?: string }>> {
    const results: Array<{ filePath: string; success: boolean; error?: string }> = [];

    for (const [key, data] of this.responses.entries()) {
      try {
        // Infer types from all responses
        const inferredTypes: InferredType[] = data.responses.map(response => inferType(response));
        const mergedType = mergeTypes(inferredTypes);

        // Generate interface name from method name (capitalize first letter)
        const interfaceName = data.methodName.charAt(0).toUpperCase() + data.methodName.slice(1) + 'Response';

        // Generate TypeScript code
        const tsCode = generateInterfaceFile(interfaceName, mergedType, data.requestParams);

        // Determine output file path
        const sourceFilePath = this.sourceFileMap.get(data.className);
        if (!sourceFilePath) {
          results.push({
            filePath: `(unknown source for ${data.className})`,
            success: false,
            error: `Source file path not found for class ${data.className}`,
          });
          continue;
        }

        // Generate output file path: <ClassName>.gentype.<methodName>.ts
        const sourceDir = path.dirname(sourceFilePath);
        const outputFileName = `${data.className}.gentype.${data.methodName}.ts`;
        const outputFilePath = path.join(sourceDir, outputFileName);

        // Write file
        await fs.writeFile(outputFilePath, tsCode, 'utf-8');

        results.push({
          filePath: outputFilePath,
          success: true,
        });
      } catch (error) {
        results.push({
          filePath: `${data.className}.gentype.${data.methodName}.ts`,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  /**
   * Clear all collected responses
   */
  clear(): void {
    this.responses.clear();
  }
}

// Singleton instance
export const typeDetector = new TypeDetector();
