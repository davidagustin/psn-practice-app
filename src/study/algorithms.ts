/**
 * ==============================================================================
 * BACKEND INTERVIEW STUDY GUIDE - COMMON ALGORITHM PATTERNS
 * ==============================================================================
 *
 * This module covers the most frequently asked algorithm patterns in backend
 * engineering interviews. Understanding these patterns helps you recognize
 * problem types and apply optimal solutions quickly.
 *
 * KEY INSIGHT FOR INTERVIEWS:
 * ==========================
 * Backend interviews differ from typical coding interviews because they
 * emphasize:
 * 1. SCALABILITY: "How does this perform with 1M users?"
 * 2. DISTRIBUTED SYSTEMS: "What if this runs on 100 servers?"
 * 3. REAL-WORLD TRADE-OFFS: "Cache hit vs miss impact?"
 *
 * PATTERN RECOGNITION STRATEGY:
 * ============================
 * 1. Read the problem carefully - identify input/output types
 * 2. Look for keywords (see below)
 * 3. Match to a pattern
 * 4. Apply the pattern's template
 * 5. Analyze time/space complexity
 *
 * PATTERN KEYWORDS CHEAT SHEET:
 * ============================
 * - "Sorted array" + "search" → Binary Search
 * - "Subarray" + "sum/max/min" → Sliding Window
 * - "Pair" + "sorted" → Two Pointers
 * - "Frequency" + "unique" → Hash Map
 * - "Shortest path" + "graph" → BFS
 * - "All paths" + "tree/graph" → DFS
 * - "Optimal" + "subproblem" → Dynamic Programming
 * ==============================================================================
 */

// ==============================================================================
// TWO POINTERS PATTERN
// ==============================================================================

/**
 * TWO POINTERS PATTERN
 * ====================
 *
 * WHEN TO USE:
 * - Working with sorted arrays
 * - Finding pairs that satisfy a condition
 * - In-place array manipulation
 * - Comparing elements from both ends
 *
 * TIME COMPLEXITY: O(n) - single pass through array
 * SPACE COMPLEXITY: O(1) - constant extra space
 *
 * INTERVIEW TIP:
 * "Two pointers is my go-to for sorted array problems. It reduces O(n^2)
 * brute force to O(n) by leveraging the sorted property."
 *
 * BACKEND APPLICATION:
 * - Merging sorted log files
 * - Finding time ranges in sorted event streams
 * - Memory-efficient data processing
 *
 * @example
 * // Find pair summing to target in sorted array
 * twoSumSorted([1, 3, 4, 5, 7, 10], 9) // returns [0, 5] (1 + 10 = 11, try 1 + 7 = 8, try 3 + 7 = 10, try 3 + 5 = 8, try 4 + 5 = 9)
 */
export function twoSumSorted(sortedNums: number[], target: number): [number, number] | null {
  /**
   * ALGORITHM WALKTHROUGH:
   * 1. Start with pointers at both ends
   * 2. If sum < target, move left pointer right (need larger number)
   * 3. If sum > target, move right pointer left (need smaller number)
   * 4. If sum == target, found it!
   *
   * WHY THIS WORKS:
   * - Array is sorted, so moving left pointer right increases sum
   * - Moving right pointer left decreases sum
   * - We never miss a valid pair because we eliminate impossible combinations
   */
  let left = 0;
  let right = sortedNums.length - 1;

  while (left < right) {
    const sum = sortedNums[left] + sortedNums[right];

    if (sum === target) {
      return [left, right];
    } else if (sum < target) {
      // Need larger sum, move left pointer right
      left++;
    } else {
      // Need smaller sum, move right pointer left
      right--;
    }
  }

  return null; // No pair found
}

/**
 * CLASSIC INTERVIEW PROBLEM: Remove Duplicates from Sorted Array
 *
 * This demonstrates in-place modification using two pointers.
 *
 * TIME: O(n)
 * SPACE: O(1) - modifies array in place
 *
 * INTERVIEW TIP:
 * "This is a common warm-up problem. The key insight is using slow/fast
 * pointers where slow tracks the write position and fast scans ahead."
 *
 * @param nums - Sorted array with potential duplicates
 * @returns Length of array after removing duplicates
 */
export function removeDuplicates(nums: number[]): number {
  if (nums.length === 0) return 0;

  /**
   * POINTER ROLES:
   * - slow: Position where next unique element should be written
   * - fast: Scans through array looking for unique elements
   *
   * INVARIANT: nums[0...slow] contains unique elements
   */
  let slow = 0;

  for (let fast = 1; fast < nums.length; fast++) {
    if (nums[fast] !== nums[slow]) {
      slow++;
      nums[slow] = nums[fast];
    }
  }

  // Length is index + 1
  return slow + 1;
}

/**
 * CONTAINER WITH MOST WATER - Classic Two Pointers
 *
 * Given n non-negative integers representing heights, find two lines
 * that together with x-axis form a container with maximum water.
 *
 * BACKEND RELEVANCE:
 * Similar logic applies to finding optimal resource allocation,
 * like maximizing throughput between two servers with different capacities.
 *
 * TIME: O(n)
 * SPACE: O(1)
 */
export function maxArea(heights: number[]): number {
  let left = 0;
  let right = heights.length - 1;
  let maxWater = 0;

  while (left < right) {
    // Width is distance between pointers
    const width = right - left;
    // Height is limited by shorter line
    const height = Math.min(heights[left], heights[right]);
    const water = width * height;
    maxWater = Math.max(maxWater, water);

    /**
     * KEY INSIGHT:
     * Move the pointer at the shorter line.
     * Why? Moving the taller line can only decrease or maintain area
     * (width decreases, height can't increase beyond current min).
     * Moving shorter line MIGHT find a taller line and increase area.
     */
    if (heights[left] < heights[right]) {
      left++;
    } else {
      right--;
    }
  }

  return maxWater;
}

// ==============================================================================
// SLIDING WINDOW PATTERN
// ==============================================================================

/**
 * SLIDING WINDOW PATTERN
 * ======================
 *
 * WHEN TO USE:
 * - Finding subarrays/substrings that satisfy conditions
 * - "Contiguous" is mentioned
 * - Need to track a running sum/count/state
 * - Maximum/minimum of all subarrays of size k
 *
 * TWO TYPES:
 * 1. FIXED SIZE: Window size is constant (e.g., "subarray of size k")
 * 2. DYNAMIC SIZE: Window grows/shrinks based on conditions
 *
 * TIME COMPLEXITY: O(n)
 * SPACE COMPLEXITY: O(1) for fixed, O(k) for dynamic where k is unique elements
 *
 * INTERVIEW TIP:
 * "Sliding window transforms O(n*k) brute force into O(n) by reusing
 * computation from the previous window."
 *
 * BACKEND APPLICATION:
 * - Rate limiting (requests in last N seconds)
 * - Moving averages for metrics
 * - Log analysis (events in time window)
 */

/**
 * FIXED SIZE SLIDING WINDOW
 *
 * Find maximum sum of any contiguous subarray of size k.
 *
 * REAL-WORLD: "Find the busiest 5-minute period in server logs"
 *
 * TIME: O(n)
 * SPACE: O(1)
 *
 * @param nums - Array of numbers
 * @param k - Window size
 * @returns Maximum sum of any k consecutive elements
 */
export function maxSumSubarrayOfSizeK(nums: number[], k: number): number {
  if (nums.length < k) {
    throw new Error('Array length must be at least k');
  }

  /**
   * ALGORITHM:
   * 1. Calculate sum of first k elements
   * 2. Slide window: add new element, remove old element
   * 3. Track maximum sum seen
   *
   * Instead of recalculating sum each time (O(k) per window = O(n*k) total),
   * we adjust by the difference (+new -old = O(1) per window = O(n) total).
   */

  // Calculate initial window sum
  let windowSum = 0;
  for (let i = 0; i < k; i++) {
    windowSum += nums[i];
  }

  let maxSum = windowSum;

  // Slide the window
  for (let i = k; i < nums.length; i++) {
    // Add new element (right side) and remove old element (left side)
    windowSum = windowSum + nums[i] - nums[i - k];
    maxSum = Math.max(maxSum, windowSum);
  }

  return maxSum;
}

/**
 * DYNAMIC SIZE SLIDING WINDOW
 *
 * Find the smallest subarray with sum >= target.
 *
 * REAL-WORLD:
 * "Find minimum time window to accumulate 1000 requests" (rate limiting)
 *
 * TIME: O(n) - each element added and removed at most once
 * SPACE: O(1)
 *
 * INTERVIEW TIP:
 * "Dynamic windows expand right until condition is met, then contract
 * left to find minimum. This is called the 'caterpillar' technique."
 */
export function minSubArrayLen(target: number, nums: number[]): number {
  let minLength = Infinity;
  let windowSum = 0;
  let windowStart = 0;

  for (let windowEnd = 0; windowEnd < nums.length; windowEnd++) {
    // Expand window
    windowSum += nums[windowEnd];

    // Contract window while condition is satisfied
    while (windowSum >= target) {
      minLength = Math.min(minLength, windowEnd - windowStart + 1);
      windowSum -= nums[windowStart];
      windowStart++;
    }
  }

  return minLength === Infinity ? 0 : minLength;
}

/**
 * SLIDING WINDOW WITH HASH MAP
 *
 * Longest substring with at most K distinct characters.
 *
 * REAL-WORLD:
 * - Session tracking: "longest period with <=K unique users"
 * - Log analysis: "longest span with <=K error types"
 *
 * TIME: O(n)
 * SPACE: O(k) for the character frequency map
 */
export function longestSubstringKDistinct(s: string, k: number): number {
  if (k === 0) return 0;

  const charCount = new Map<string, number>();
  let maxLength = 0;
  let windowStart = 0;

  for (let windowEnd = 0; windowEnd < s.length; windowEnd++) {
    // Add character to window
    const rightChar = s[windowEnd];
    charCount.set(rightChar, (charCount.get(rightChar) || 0) + 1);

    // Shrink window until we have at most k distinct characters
    while (charCount.size > k) {
      const leftChar = s[windowStart];
      charCount.set(leftChar, charCount.get(leftChar)! - 1);
      if (charCount.get(leftChar) === 0) {
        charCount.delete(leftChar);
      }
      windowStart++;
    }

    maxLength = Math.max(maxLength, windowEnd - windowStart + 1);
  }

  return maxLength;
}

// ==============================================================================
// HASH MAP PATTERN
// ==============================================================================

/**
 * HASH MAP PATTERN
 * ================
 *
 * WHEN TO USE:
 * - Counting frequencies
 * - Finding duplicates
 * - Caching/memoization
 * - Two-sum style problems (unsorted)
 * - Grouping by key
 *
 * TIME COMPLEXITY: O(1) average for get/set
 * SPACE COMPLEXITY: O(n) for storing n unique keys
 *
 * INTERVIEW TIP:
 * "Hash maps trade space for time. When asked to optimize O(n^2) to O(n),
 * think hash map first."
 *
 * BACKEND APPLICATION:
 * - In-memory caching
 * - Request deduplication
 * - Rate limiting (count requests per user)
 * - Session storage
 */

/**
 * TWO SUM - THE MOST FAMOUS LEETCODE PROBLEM
 *
 * Find two numbers that add up to target, return their indices.
 *
 * BRUTE FORCE: O(n^2) - check every pair
 * HASH MAP: O(n) - single pass with complement lookup
 *
 * REAL-WORLD:
 * - Finding complementary items (e.g., products that together reach free shipping)
 * - Matching buy/sell orders in trading systems
 *
 * @param nums - Array of numbers
 * @param target - Target sum
 * @returns Indices of the two numbers, or null if not found
 */
export function twoSum(nums: number[], target: number): [number, number] | null {
  /**
   * ALGORITHM:
   * For each number, we need to find if its complement (target - num) exists.
   * Store numbers we've seen in a hash map.
   * When we find a number whose complement is in the map, we're done.
   *
   * INTERVIEW TIP:
   * "I use a hash map to store seen values, turning complement lookup
   * from O(n) scan to O(1) lookup."
   */
  const seen = new Map<number, number>(); // value -> index

  for (let i = 0; i < nums.length; i++) {
    const complement = target - nums[i];

    if (seen.has(complement)) {
      return [seen.get(complement)!, i];
    }

    seen.set(nums[i], i);
  }

  return null;
}

/**
 * GROUP ANAGRAMS
 *
 * Group strings that are anagrams of each other.
 *
 * KEY INSIGHT:
 * Anagrams have the same characters, so sorted versions are identical.
 * Use sorted string as the hash key.
 *
 * TIME: O(n * k * log(k)) where n = number of strings, k = max string length
 * SPACE: O(n * k) for storing all strings
 *
 * REAL-WORLD:
 * - Grouping similar search queries
 * - Deduplicating permutations
 */
export function groupAnagrams(strs: string[]): string[][] {
  const groups = new Map<string, string[]>();

  for (const str of strs) {
    // Sort characters to create canonical key
    const key = str.split('').sort().join('');

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(str);
  }

  return Array.from(groups.values());
}

/**
 * FREQUENCY COUNT PATTERN
 *
 * Check if two strings are anagrams.
 *
 * Instead of sorting, count character frequencies.
 *
 * TIME: O(n)
 * SPACE: O(1) - at most 26 lowercase letters
 */
export function isAnagram(s: string, t: string): boolean {
  if (s.length !== t.length) return false;

  const freq = new Map<string, number>();

  // Count characters in first string
  for (const char of s) {
    freq.set(char, (freq.get(char) || 0) + 1);
  }

  // Decrement for second string
  for (const char of t) {
    const count = freq.get(char);
    if (!count) return false; // Character not in s or used up
    freq.set(char, count - 1);
  }

  return true;
}

/**
 * LRU CACHE - CRITICAL BACKEND DATA STRUCTURE
 *
 * Least Recently Used cache implementation.
 * When cache is full, evict the least recently accessed item.
 *
 * WHY THIS IS IMPORTANT FOR BACKEND:
 * - Every backend system uses caching
 * - Understanding LRU is fundamental
 * - Shows you understand memory management
 *
 * TIME: O(1) for get and put
 * SPACE: O(capacity)
 *
 * IMPLEMENTATION:
 * - Hash Map for O(1) key lookup
 * - Doubly Linked List for O(1) insertion/deletion
 * - Map stores key -> node reference
 *
 * INTERVIEW TIP:
 * "LRU cache is implemented with a hash map for O(1) lookup and a doubly
 * linked list for O(1) reordering. The most recently used item is at the
 * head, least recently used at the tail."
 */
class DoublyLinkedListNode<K, V> {
  key: K;
  value: V;
  prev: DoublyLinkedListNode<K, V> | null = null;
  next: DoublyLinkedListNode<K, V> | null = null;

  constructor(key: K, value: V) {
    this.key = key;
    this.value = value;
  }
}

export class LRUCache<K, V> {
  private capacity: number;
  private cache: Map<K, DoublyLinkedListNode<K, V>>;
  private head: DoublyLinkedListNode<K, V>; // Most recently used (dummy)
  private tail: DoublyLinkedListNode<K, V>; // Least recently used (dummy)

  /**
   * Create an LRU cache with the given capacity.
   *
   * DESIGN NOTE:
   * We use dummy head and tail nodes to simplify edge cases.
   * Real items are always between head and tail.
   */
  constructor(capacity: number) {
    this.capacity = capacity;
    this.cache = new Map();

    // Initialize dummy head and tail
    this.head = new DoublyLinkedListNode<K, V>(null as unknown as K, null as unknown as V);
    this.tail = new DoublyLinkedListNode<K, V>(null as unknown as K, null as unknown as V);
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  /**
   * Get value by key. Returns undefined if not found.
   * Moves accessed item to front (most recently used).
   */
  get(key: K): V | undefined {
    const node = this.cache.get(key);
    if (!node) return undefined;

    // Move to front (most recently used)
    this.removeNode(node);
    this.addToFront(node);

    return node.value;
  }

  /**
   * Set key-value pair.
   * If key exists, update value and move to front.
   * If cache is full, evict least recently used item.
   */
  put(key: K, value: V): void {
    const existingNode = this.cache.get(key);

    if (existingNode) {
      // Update existing key
      existingNode.value = value;
      this.removeNode(existingNode);
      this.addToFront(existingNode);
    } else {
      // Add new key
      const newNode = new DoublyLinkedListNode(key, value);

      // Evict if at capacity
      if (this.cache.size >= this.capacity) {
        const lruNode = this.tail.prev!;
        this.removeNode(lruNode);
        this.cache.delete(lruNode.key);
      }

      this.addToFront(newNode);
      this.cache.set(key, newNode);
    }
  }

  /**
   * Remove a node from the linked list.
   */
  private removeNode(node: DoublyLinkedListNode<K, V>): void {
    node.prev!.next = node.next;
    node.next!.prev = node.prev;
  }

  /**
   * Add a node right after head (most recently used position).
   */
  private addToFront(node: DoublyLinkedListNode<K, V>): void {
    node.next = this.head.next;
    node.prev = this.head;
    this.head.next!.prev = node;
    this.head.next = node;
  }

  /**
   * Get current cache size.
   */
  size(): number {
    return this.cache.size;
  }
}

// ==============================================================================
// BFS (BREADTH-FIRST SEARCH) PATTERN
// ==============================================================================

/**
 * BFS PATTERN
 * ===========
 *
 * WHEN TO USE:
 * - Finding SHORTEST path (unweighted graphs)
 * - Level-by-level traversal
 * - Finding all nodes at a given distance
 * - Testing bipartiteness
 *
 * TIME COMPLEXITY: O(V + E) where V = vertices, E = edges
 * SPACE COMPLEXITY: O(V) for the queue
 *
 * INTERVIEW TIP:
 * "BFS guarantees shortest path in unweighted graphs because it explores
 * all nodes at distance d before any node at distance d+1."
 *
 * BACKEND APPLICATION:
 * - Social network: "Find users within 3 connections"
 * - Dependency resolution: "Find all direct dependencies first"
 * - Service discovery: "Find services within 2 hops"
 */

/**
 * Graph representation using adjacency list.
 * More memory efficient than adjacency matrix for sparse graphs.
 *
 * INTERVIEW TIP:
 * "I prefer adjacency lists for sparse graphs (which most real-world
 * graphs are). Space is O(V + E) vs O(V^2) for matrices."
 */
export type Graph = Map<string, string[]>;

/**
 * BFS SHORTEST PATH
 *
 * Find shortest path between two nodes in unweighted graph.
 *
 * REAL-WORLD:
 * - Social network: "degrees of separation"
 * - Routing: "minimum hops between servers"
 * - Game: "minimum moves to reach target"
 *
 * @param graph - Adjacency list representation
 * @param start - Starting node
 * @param end - Target node
 * @returns Array of nodes in the shortest path, or empty if no path
 */
export function bfsShortestPath(graph: Graph, start: string, end: string): string[] {
  if (start === end) return [start];

  /**
   * ALGORITHM:
   * 1. Use queue for FIFO processing (key to BFS)
   * 2. Track visited nodes to avoid cycles
   * 3. Store parent of each node to reconstruct path
   * 4. When we find end, trace back through parents
   */
  const queue: string[] = [start];
  const visited = new Set<string>([start]);
  const parent = new Map<string, string>(); // child -> parent

  while (queue.length > 0) {
    const current = queue.shift()!;

    const neighbors = graph.get(current) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        parent.set(neighbor, current);

        if (neighbor === end) {
          // Reconstruct path
          return reconstructPath(parent, start, end);
        }

        queue.push(neighbor);
      }
    }
  }

  return []; // No path found
}

/**
 * Helper to reconstruct path from parent map.
 */
function reconstructPath(
  parent: Map<string, string>,
  start: string,
  end: string
): string[] {
  const path: string[] = [];
  let current: string | undefined = end;

  while (current !== undefined) {
    path.unshift(current);
    if (current === start) break;
    current = parent.get(current);
  }

  return path;
}

/**
 * LEVEL ORDER TRAVERSAL
 *
 * Process graph level by level.
 * Returns array of arrays, where each inner array is one level.
 *
 * REAL-WORLD:
 * - Org chart: "Find all employees at each level"
 * - Build system: "Process dependencies level by level"
 *
 * TIME: O(V + E)
 * SPACE: O(V)
 */
export function levelOrderTraversal(graph: Graph, start: string): string[][] {
  const result: string[][] = [];
  const visited = new Set<string>([start]);
  let currentLevel = [start];

  while (currentLevel.length > 0) {
    result.push([...currentLevel]);
    const nextLevel: string[] = [];

    for (const node of currentLevel) {
      const neighbors = graph.get(node) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          nextLevel.push(neighbor);
        }
      }
    }

    currentLevel = nextLevel;
  }

  return result;
}

// ==============================================================================
// DFS (DEPTH-FIRST SEARCH) PATTERN
// ==============================================================================

/**
 * DFS PATTERN
 * ===========
 *
 * WHEN TO USE:
 * - Finding ALL paths
 * - Detecting cycles
 * - Topological sorting
 * - Connected components
 * - Tree traversals
 *
 * TIME COMPLEXITY: O(V + E)
 * SPACE COMPLEXITY: O(V) for recursion stack
 *
 * INTERVIEW TIP:
 * "DFS is good for exhaustive exploration. BFS for shortest path.
 * DFS uses less memory for wide graphs, BFS uses less for deep graphs."
 *
 * BACKEND APPLICATION:
 * - Dependency graph: cycle detection
 * - File system: recursive directory traversal
 * - Transaction: detect circular dependencies
 */

/**
 * DFS FIND ALL PATHS
 *
 * Find all paths from start to end.
 *
 * REAL-WORLD:
 * - Network: "All possible routes between servers"
 * - Permission: "All ways a user can access a resource"
 *
 * @param graph - Adjacency list
 * @param start - Starting node
 * @param end - Target node
 * @returns Array of all paths (each path is an array of nodes)
 */
export function dfsAllPaths(graph: Graph, start: string, end: string): string[][] {
  const allPaths: string[][] = [];
  const currentPath: string[] = [start];
  const visited = new Set<string>([start]);

  function dfs(node: string): void {
    if (node === end) {
      allPaths.push([...currentPath]);
      return;
    }

    const neighbors = graph.get(node) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        // BACKTRACKING:
        // Add to path, explore, then remove
        // This allows exploring all possibilities
        visited.add(neighbor);
        currentPath.push(neighbor);

        dfs(neighbor);

        // Backtrack
        currentPath.pop();
        visited.delete(neighbor);
      }
    }
  }

  dfs(start);
  return allPaths;
}

/**
 * CYCLE DETECTION IN DIRECTED GRAPH
 *
 * Detect if a directed graph has a cycle.
 *
 * CRITICAL FOR BACKEND:
 * - Deadlock detection
 * - Circular dependency in builds
 * - Infinite loop in workflows
 *
 * ALGORITHM:
 * Use three states for each node:
 * - UNVISITED: Not yet explored
 * - VISITING: Currently in the DFS stack (exploring its subtree)
 * - VISITED: Fully explored
 *
 * If we encounter a VISITING node, we found a cycle.
 *
 * TIME: O(V + E)
 * SPACE: O(V)
 */
export function hasCycle(graph: Graph): boolean {
  enum State {
    UNVISITED,
    VISITING,
    VISITED,
  }

  const state = new Map<string, State>();

  // Initialize all nodes as unvisited
  for (const node of graph.keys()) {
    state.set(node, State.UNVISITED);
  }

  function dfs(node: string): boolean {
    state.set(node, State.VISITING);

    const neighbors = graph.get(node) || [];
    for (const neighbor of neighbors) {
      const neighborState = state.get(neighbor);

      if (neighborState === State.VISITING) {
        // Found a back edge - cycle detected!
        return true;
      }

      if (neighborState === State.UNVISITED) {
        if (dfs(neighbor)) return true;
      }
    }

    state.set(node, State.VISITED);
    return false;
  }

  // Check all nodes (graph may be disconnected)
  for (const node of graph.keys()) {
    if (state.get(node) === State.UNVISITED) {
      if (dfs(node)) return true;
    }
  }

  return false;
}

/**
 * TOPOLOGICAL SORT
 *
 * Order nodes so that for every edge (u, v), u comes before v.
 * Only works for DAGs (Directed Acyclic Graphs).
 *
 * CRITICAL FOR BACKEND:
 * - Build systems: compile dependencies in order
 * - Task scheduling: run prerequisites first
 * - Database migrations: apply in order
 *
 * TIME: O(V + E)
 * SPACE: O(V)
 *
 * INTERVIEW TIP:
 * "I use topological sort for any dependency ordering problem.
 * The key is post-order DFS - add to result after processing all children."
 */
export function topologicalSort(graph: Graph): string[] | null {
  enum State {
    UNVISITED,
    VISITING,
    VISITED,
  }

  const state = new Map<string, State>();
  const result: string[] = [];

  // Initialize all nodes
  for (const node of graph.keys()) {
    state.set(node, State.UNVISITED);
  }

  function dfs(node: string): boolean {
    state.set(node, State.VISITING);

    const neighbors = graph.get(node) || [];
    for (const neighbor of neighbors) {
      const neighborState = state.get(neighbor);

      if (neighborState === State.VISITING) {
        // Cycle detected - topological sort impossible
        return false;
      }

      if (neighborState === State.UNVISITED) {
        if (!dfs(neighbor)) return false;
      }
    }

    state.set(node, State.VISITED);
    // Post-order: add AFTER processing all dependencies
    result.unshift(node);
    return true;
  }

  for (const node of graph.keys()) {
    if (state.get(node) === State.UNVISITED) {
      if (!dfs(node)) return null; // Cycle detected
    }
  }

  return result;
}

// ==============================================================================
// BINARY SEARCH PATTERN
// ==============================================================================

/**
 * BINARY SEARCH PATTERN
 * =====================
 *
 * WHEN TO USE:
 * - Sorted array search
 * - Finding boundaries (first/last occurrence)
 * - Search space reduction problems
 * - "Minimize the maximum" / "Maximize the minimum" problems
 *
 * TIME COMPLEXITY: O(log n)
 * SPACE COMPLEXITY: O(1)
 *
 * INTERVIEW TIP:
 * "Binary search isn't just for finding elements. It's for any monotonic
 * search space where I can eliminate half the options each step."
 *
 * BACKEND APPLICATION:
 * - Log search by timestamp
 * - Finding rate limits (binary search on threshold)
 * - Database index lookups
 */

/**
 * CLASSIC BINARY SEARCH
 *
 * Find target in sorted array.
 *
 * TIME: O(log n)
 * SPACE: O(1)
 *
 * @param nums - Sorted array
 * @param target - Value to find
 * @returns Index of target, or -1 if not found
 */
export function binarySearch(nums: number[], target: number): number {
  let left = 0;
  let right = nums.length - 1;

  while (left <= right) {
    // Prevent integer overflow (not an issue in JS, but good practice)
    const mid = left + Math.floor((right - left) / 2);

    if (nums[mid] === target) {
      return mid;
    } else if (nums[mid] < target) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return -1;
}

/**
 * FIND FIRST OCCURRENCE (Lower Bound)
 *
 * Find the first index where target appears (or would be inserted).
 *
 * REAL-WORLD:
 * - "Find first log entry after timestamp X"
 * - "Find first user with ID >= X"
 *
 * TIME: O(log n)
 */
export function lowerBound(nums: number[], target: number): number {
  let left = 0;
  let right = nums.length;

  while (left < right) {
    const mid = left + Math.floor((right - left) / 2);

    if (nums[mid] < target) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  return left;
}

/**
 * FIND LAST OCCURRENCE (Upper Bound)
 *
 * Find the first index where value > target.
 *
 * REAL-WORLD:
 * - "Find logs AFTER timestamp X" (exclusive)
 *
 * TIME: O(log n)
 */
export function upperBound(nums: number[], target: number): number {
  let left = 0;
  let right = nums.length;

  while (left < right) {
    const mid = left + Math.floor((right - left) / 2);

    if (nums[mid] <= target) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  return left;
}

/**
 * BINARY SEARCH ON ANSWER - ADVANCED PATTERN
 *
 * Given a function that tells if a value "works", find minimum/maximum
 * value that works.
 *
 * EXAMPLE: Ship packages in D days. Find minimum ship capacity.
 *
 * REAL-WORLD:
 * - "What's minimum server capacity to handle load?"
 * - "What's minimum batch size to finish in time?"
 *
 * PATTERN:
 * 1. Define search range [min possible, max possible]
 * 2. Binary search for optimal value
 * 3. Use helper function to check if value is feasible
 *
 * TIME: O(n * log(range))
 */
export function shipWithinDays(weights: number[], days: number): number {
  // Minimum capacity: must hold largest single package
  // Maximum capacity: ship everything in one day
  let left = Math.max(...weights);
  let right = weights.reduce((a, b) => a + b, 0);

  /**
   * Helper: Can we ship all packages in `days` with capacity `cap`?
   */
  function canShip(capacity: number): boolean {
    let daysNeeded = 1;
    let currentLoad = 0;

    for (const weight of weights) {
      if (currentLoad + weight > capacity) {
        daysNeeded++;
        currentLoad = 0;
      }
      currentLoad += weight;
    }

    return daysNeeded <= days;
  }

  // Binary search for minimum capacity
  while (left < right) {
    const mid = left + Math.floor((right - left) / 2);

    if (canShip(mid)) {
      right = mid; // Try smaller capacity
    } else {
      left = mid + 1; // Need more capacity
    }
  }

  return left;
}

// ==============================================================================
// DYNAMIC PROGRAMMING BASICS
// ==============================================================================

/**
 * DYNAMIC PROGRAMMING PATTERN
 * ===========================
 *
 * WHEN TO USE:
 * - Optimal substructure: optimal solution built from optimal sub-solutions
 * - Overlapping subproblems: same subproblems solved multiple times
 * - Keywords: "minimum", "maximum", "count ways", "is possible"
 *
 * TWO APPROACHES:
 * 1. TOP-DOWN (Memoization): Recursive + cache
 * 2. BOTTOM-UP (Tabulation): Iterative, build table
 *
 * TIME COMPLEXITY: O(n * m) typically (depends on state space)
 * SPACE COMPLEXITY: O(n) or O(n * m) for the table
 *
 * INTERVIEW TIP:
 * "I start with brute force recursion, identify overlapping subproblems,
 * then add memoization. If iterative is cleaner, I convert to bottom-up."
 *
 * BACKEND APPLICATION:
 * - Resource allocation optimization
 * - Cost minimization in cloud pricing
 * - Caching strategy optimization
 */

/**
 * FIBONACCI - Classic DP Introduction
 *
 * Demonstrates the power of memoization.
 *
 * NAIVE: O(2^n) - exponential
 * MEMOIZED: O(n) - linear
 *
 * INTERVIEW TIP:
 * "This is the simplest example of DP. The naive solution recalculates
 * fib(k) many times. Memoization stores each result once."
 */
export function fibonacciMemoized(n: number, memo: Map<number, number> = new Map()): number {
  if (n <= 1) return n;
  if (memo.has(n)) return memo.get(n)!;

  const result = fibonacciMemoized(n - 1, memo) + fibonacciMemoized(n - 2, memo);
  memo.set(n, result);
  return result;
}

/**
 * FIBONACCI - Bottom-Up
 *
 * Iterative approach. Often more efficient due to no recursion overhead.
 *
 * TIME: O(n)
 * SPACE: O(1) - only need last two values
 */
export function fibonacciBottomUp(n: number): number {
  if (n <= 1) return n;

  let prev2 = 0;
  let prev1 = 1;

  for (let i = 2; i <= n; i++) {
    const current = prev1 + prev2;
    prev2 = prev1;
    prev1 = current;
  }

  return prev1;
}

/**
 * CLIMBING STAIRS - DP Classic
 *
 * Count ways to climb n stairs taking 1 or 2 steps at a time.
 *
 * RECURRENCE: dp[i] = dp[i-1] + dp[i-2]
 * (Can reach stair i from stair i-1 with 1 step, or from i-2 with 2 steps)
 *
 * This is actually Fibonacci in disguise!
 *
 * TIME: O(n)
 * SPACE: O(1)
 */
export function climbStairs(n: number): number {
  if (n <= 2) return n;

  let twoBack = 1; // Ways to reach stair 1
  let oneBack = 2; // Ways to reach stair 2

  for (let i = 3; i <= n; i++) {
    const current = oneBack + twoBack;
    twoBack = oneBack;
    oneBack = current;
  }

  return oneBack;
}

/**
 * COIN CHANGE - Classic DP
 *
 * Find minimum number of coins to make amount.
 *
 * This is a FUNDAMENTAL DP problem that appears in many forms:
 * - Resource allocation
 * - Task scheduling
 * - Network routing cost
 *
 * RECURRENCE:
 * dp[amount] = min(dp[amount - coin]) + 1 for each coin
 *
 * TIME: O(amount * coins.length)
 * SPACE: O(amount)
 *
 * INTERVIEW TIP:
 * "I define dp[i] as minimum coins to make amount i. For each amount,
 * I try each coin and take the minimum."
 */
export function coinChange(coins: number[], amount: number): number {
  // dp[i] = minimum coins to make amount i
  // Initialize with Infinity (impossible to make this amount yet)
  const dp: number[] = new Array(amount + 1).fill(Infinity);
  dp[0] = 0; // Base case: 0 coins to make amount 0

  for (let i = 1; i <= amount; i++) {
    for (const coin of coins) {
      if (coin <= i && dp[i - coin] !== Infinity) {
        dp[i] = Math.min(dp[i], dp[i - coin] + 1);
      }
    }
  }

  return dp[amount] === Infinity ? -1 : dp[amount];
}

/**
 * LONGEST INCREASING SUBSEQUENCE (LIS)
 *
 * Find length of longest subsequence where elements are strictly increasing.
 *
 * REAL-WORLD:
 * - Stock trading: longest period of increasing prices
 * - Metrics: longest upward trend
 *
 * BASIC DP: O(n^2)
 * dp[i] = length of LIS ending at index i
 *
 * OPTIMIZED: O(n log n) using binary search (shown below)
 *
 * INTERVIEW TIP:
 * "The O(n^2) solution is intuitive. For optimization, I maintain a list
 * of smallest tail elements for subsequences of each length, using binary
 * search for updates."
 */
export function lengthOfLIS(nums: number[]): number {
  if (nums.length === 0) return 0;

  // O(n^2) approach - easier to explain in interview
  const dp: number[] = new Array(nums.length).fill(1);

  for (let i = 1; i < nums.length; i++) {
    for (let j = 0; j < i; j++) {
      if (nums[j] < nums[i]) {
        dp[i] = Math.max(dp[i], dp[j] + 1);
      }
    }
  }

  return Math.max(...dp);
}

/**
 * LONGEST INCREASING SUBSEQUENCE - O(n log n) Optimized
 *
 * Uses binary search for better time complexity.
 *
 * ALGORITHM:
 * Maintain array `tails` where tails[i] = smallest tail element for LIS of length i+1.
 * For each number, either extend the longest sequence or replace a tail.
 *
 * TIME: O(n log n)
 * SPACE: O(n)
 */
export function lengthOfLISOptimized(nums: number[]): number {
  if (nums.length === 0) return 0;

  // tails[i] = smallest tail of all LIS of length i+1
  const tails: number[] = [];

  for (const num of nums) {
    // Binary search for position to insert/replace
    let left = 0;
    let right = tails.length;

    while (left < right) {
      const mid = left + Math.floor((right - left) / 2);
      if (tails[mid] < num) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }

    if (left === tails.length) {
      // Extend longest sequence
      tails.push(num);
    } else {
      // Replace tail at this length
      tails[left] = num;
    }
  }

  return tails.length;
}

/**
 * 0/1 KNAPSACK - Classic DP
 *
 * Given items with weights and values, find maximum value that fits in capacity.
 *
 * REAL-WORLD:
 * - Resource allocation: maximize benefit within budget
 * - Cloud pricing: maximize performance within cost limit
 *
 * TIME: O(n * W) where n = items, W = capacity
 * SPACE: O(W) with optimization
 *
 * INTERVIEW TIP:
 * "I define dp[w] as max value achievable with capacity w. For each item,
 * I decide whether to include it based on remaining capacity."
 */
export function knapsack(weights: number[], values: number[], capacity: number): number {
  const n = weights.length;

  // dp[w] = maximum value achievable with capacity w
  const dp: number[] = new Array(capacity + 1).fill(0);

  for (let i = 0; i < n; i++) {
    // Process backwards to avoid using same item twice
    for (let w = capacity; w >= weights[i]; w--) {
      dp[w] = Math.max(
        dp[w], // Don't take item i
        dp[w - weights[i]] + values[i] // Take item i
      );
    }
  }

  return dp[capacity];
}

// ==============================================================================
// EXPORT HELPER FOR TESTING
// ==============================================================================

/**
 * Create a graph from edge list for testing.
 *
 * @param edges - Array of [from, to] pairs
 * @param directed - Whether graph is directed (default: true)
 * @returns Graph as adjacency list
 */
export function createGraph(edges: [string, string][], directed: boolean = true): Graph {
  const graph: Graph = new Map();

  for (const [from, to] of edges) {
    if (!graph.has(from)) graph.set(from, []);
    if (!graph.has(to)) graph.set(to, []);

    graph.get(from)!.push(to);
    if (!directed) {
      graph.get(to)!.push(from);
    }
  }

  return graph;
}

/**
 * INTERVIEW PREPARATION SUMMARY
 * =============================
 *
 * PATTERN RECOGNITION QUICK GUIDE:
 *
 * 1. SORTED ARRAY → Binary Search or Two Pointers
 * 2. UNSORTED ARRAY + "FIND PAIR/GROUP" → Hash Map
 * 3. SUBARRAY/SUBSTRING → Sliding Window
 * 4. SHORTEST PATH → BFS
 * 5. ALL PATHS / CONNECTIVITY → DFS
 * 6. "MINIMUM/MAXIMUM" + "SUBPROBLEM" → DP
 * 7. DEPENDENCIES / ORDERING → Topological Sort
 * 8. "AT MOST K" / "EXACTLY K" → Sliding Window + Hash Map
 *
 * COMPLEXITY QUICK REFERENCE:
 *
 * | Algorithm | Time | Space |
 * |-----------|------|-------|
 * | Two Pointers | O(n) | O(1) |
 * | Sliding Window | O(n) | O(k) |
 * | Hash Map | O(n) | O(n) |
 * | Binary Search | O(log n) | O(1) |
 * | BFS/DFS | O(V + E) | O(V) |
 * | DP | O(n*m) | O(n) or O(n*m) |
 *
 * INTERVIEW COMMUNICATION TIPS:
 *
 * 1. STATE PATTERN: "I see [keyword], so I'll try [pattern]"
 * 2. STATE COMPLEXITY: "This is O(n) time, O(1) space"
 * 3. STATE TRADE-OFFS: "I'm trading space for time here"
 * 4. STATE ALTERNATIVES: "Another approach would be..."
 * 5. TEST EDGE CASES: "Let me check empty input, single element..."
 */
