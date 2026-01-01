/**
 * Tests for HTTP registry functions that retrieve @http decorated methods
 * including parent class methods
 */

import {
  http,
  getHttpRequesters,
  getHttpRequestersForClass,
  getHttpRequesterForClassMethod,
  type HTTPObj,
  stopHttpQueue,
} from '../http';

// Stop the HTTP queue processor for tests
stopHttpQueue();

// Base class with HTTP methods
class BaseClass {
  @http({
    parameters: [
      {name: 'id', type: 'string', description: 'Resource ID', required: true, example: '123'},
    ],
  })
  async fetchBase(id: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `https://api.example.com/base/${id}`,
      tags: ['base'],
    } as HTTPObj;
  }

  @http({
    parameters: [
      {name: 'name', type: 'string', description: 'Name', required: true, example: 'test'},
    ],
  })
  async createBase(name: string): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: 'https://api.example.com/base',
      body: {name},
      tags: ['base'],
    } as HTTPObj;
  }
}

// Child class that extends BaseClass
class ChildClass extends BaseClass {
  @http({
    parameters: [
      {name: 'query', type: 'string', description: 'Search query', required: true, example: 'test'},
    ],
  })
  async searchChild(query: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `https://api.example.com/child/search?q=${query}`,
      tags: ['child'],
    } as HTTPObj;
  }

  @http()
  async getChild(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: 'https://api.example.com/child',
      tags: ['child'],
    } as HTTPObj;
  }
}

// Another child class for testing isolation
class AnotherChild extends BaseClass {
  @http()
  async fetchAnother(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: 'https://api.example.com/another',
      tags: ['another'],
    } as HTTPObj;
  }
}

describe('HTTP Registry Functions', () => {
  describe('getHttpRequesters', () => {
    it('should return all registered HTTP methods', () => {
      const allRequesters = getHttpRequesters();

      // Should have methods from BaseClass, ChildClass, and AnotherChild
      expect(allRequesters.length).toBeGreaterThanOrEqual(5);

      const methodNames = allRequesters.map(r => r.methodName);
      expect(methodNames).toContain('fetchBase');
      expect(methodNames).toContain('createBase');
      expect(methodNames).toContain('searchChild');
      expect(methodNames).toContain('getChild');
      expect(methodNames).toContain('fetchAnother');
    });
  });

  describe('getHttpRequestersForClass', () => {
    it('should return only methods from BaseClass', () => {
      const baseRequesters = getHttpRequestersForClass(BaseClass);

      expect(baseRequesters.length).toBe(2);

      const methodNames = baseRequesters.map(r => r.methodName);
      expect(methodNames).toContain('fetchBase');
      expect(methodNames).toContain('createBase');
    });

    it('should return methods from ChildClass and its parent', () => {
      const childRequesters = getHttpRequestersForClass(ChildClass);

      // Should include: searchChild, getChild (from ChildClass) + fetchBase, createBase (from BaseClass)
      expect(childRequesters.length).toBe(4);

      const methodNames = childRequesters.map(r => r.methodName);
      expect(methodNames).toContain('fetchBase');
      expect(methodNames).toContain('createBase');
      expect(methodNames).toContain('searchChild');
      expect(methodNames).toContain('getChild');
    });

    it('should return methods from AnotherChild and its parent', () => {
      const anotherRequesters = getHttpRequestersForClass(AnotherChild);

      // Should include: fetchAnother (from AnotherChild) + fetchBase, createBase (from BaseClass)
      expect(anotherRequesters.length).toBe(3);

      const methodNames = anotherRequesters.map(r => r.methodName);
      expect(methodNames).toContain('fetchBase');
      expect(methodNames).toContain('createBase');
      expect(methodNames).toContain('fetchAnother');
    });

    it('should not include methods from sibling classes', () => {
      const childRequesters = getHttpRequestersForClass(ChildClass);
      const methodNames = childRequesters.map(r => r.methodName);

      // Should NOT include methods from AnotherChild
      expect(methodNames).not.toContain('fetchAnother');
    });
  });

  describe('getHttpRequesterForClassMethod', () => {
    it('should find method directly on the class', () => {
      const requester = getHttpRequesterForClassMethod(ChildClass, 'searchChild');

      expect(requester).toBeDefined();
      expect(requester?.methodName).toBe('searchChild');
      expect(requester?.args).toHaveLength(1);
      expect(requester?.args[0].name).toBe('query');
    });

    it('should find method from parent class', () => {
      const requester = getHttpRequesterForClassMethod(ChildClass, 'fetchBase');

      expect(requester).toBeDefined();
      expect(requester?.methodName).toBe('fetchBase');
      expect(requester?.args).toHaveLength(1);
      expect(requester?.args[0].name).toBe('id');
    });

    it('should return undefined for non-existent method', () => {
      const requester = getHttpRequesterForClassMethod(ChildClass, 'nonExistentMethod');

      expect(requester).toBeUndefined();
    });

    it('should not find methods from sibling classes', () => {
      const requester = getHttpRequesterForClassMethod(ChildClass, 'fetchAnother');

      expect(requester).toBeUndefined();
    });

    it('should find method with no parameters', () => {
      const requester = getHttpRequesterForClassMethod(ChildClass, 'getChild');

      expect(requester).toBeDefined();
      expect(requester?.methodName).toBe('getChild');
      expect(requester?.args).toHaveLength(0);
    });
  });

  describe('Parameter preservation', () => {
    it('should preserve parameter definitions from decorator', () => {
      const requester = getHttpRequesterForClassMethod(BaseClass, 'fetchBase');

      expect(requester?.args).toHaveLength(1);
      expect(requester?.args[0]).toEqual({
        name: 'id',
        type: 'string',
        description: 'Resource ID',
        required: true,
        example: '123',
      });
    });

    it('should handle multiple parameters', () => {
      const requester = getHttpRequesterForClassMethod(BaseClass, 'createBase');

      expect(requester?.args).toHaveLength(1);
      expect(requester?.args[0].name).toBe('name');
      expect(requester?.args[0].type).toBe('string');
    });

    it('should handle methods with no parameter definitions', () => {
      const requester = getHttpRequesterForClassMethod(ChildClass, 'getChild');

      expect(requester?.args).toHaveLength(0);
    });
  });

  describe('Inheritance chain', () => {
    it('should work with multiple levels of inheritance', () => {
      // Create a grandchild class
      class GrandchildClass extends ChildClass {
        @http()
        async fetchGrandchild(): Promise<HTTPObj> {
          return {
            method: 'GET',
            url: 'https://api.example.com/grandchild',
            tags: ['grandchild'],
          } as HTTPObj;
        }
      }

      const requesters = getHttpRequestersForClass(GrandchildClass);

      // Should include methods from: GrandchildClass (1) + ChildClass (2) + BaseClass (2) = 5
      expect(requesters.length).toBe(5);

      const methodNames = requesters.map(r => r.methodName);
      expect(methodNames).toContain('fetchBase'); // From BaseClass
      expect(methodNames).toContain('createBase'); // From BaseClass
      expect(methodNames).toContain('searchChild'); // From ChildClass
      expect(methodNames).toContain('getChild'); // From ChildClass
      expect(methodNames).toContain('fetchGrandchild'); // From GrandchildClass
    });
  });
});
