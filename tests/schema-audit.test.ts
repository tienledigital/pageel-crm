import { describe, it, expect } from 'vitest';
import * as schema from '../src/lib/db/schema';


describe('Inspect Drizzle Schema Structure', () => {
  it('should detect circular foreign keys and ensure at least one is nullable', () => {
    // 1. Get all tables from the schema
    const tables: any[] = [];
    for (const key of Object.keys(schema)) {
      const value = (schema as any)[key];
      if (value && typeof value === 'object') {
        const isTableSym = Object.getOwnPropertySymbols(value).find(s => s.toString().includes('IsDrizzleTable'));
        if (isTableSym && value[isTableSym] === true) {
          tables.push(value);
        }
      }
    }

    function getTableName(table: any): string {
      const nameSym = Object.getOwnPropertySymbols(table).find(s => s.toString().includes('drizzle:Name'));
      return nameSym ? table[nameSym] : 'unknown';
    }

    // 2. Build adjacency list of directed foreign keys
    const adjList: Record<string, Array<{ to: string; columns: string[]; isNullable: boolean }>> = {};
    
    for (const table of tables) {
      const tableName = getTableName(table);
      adjList[tableName] = [];
      
      const fksSym = Object.getOwnPropertySymbols(table).find(s => s.toString().includes('SQLiteInlineForeignKeys'));
      if (fksSym) {
        const fks = table[fksSym] || [];
        for (const fk of fks) {
          const ref = fk.reference();
          const targetTableName = getTableName(ref.foreignTable);
          const columns = ref.columns || [];
          
          // A foreign key is nullable if at least one of its referencing columns is nullable (notNull !== true)
          const isNullable = columns.some((col: any) => !col.notNull);
          
          adjList[tableName].push({
            to: targetTableName,
            columns: columns.map((col: any) => col.name),
            isNullable
          });
        }
      }
    }

    // 3. DFS to find all simple cycles in the directed graph
    const cycles: Array<{ nodes: string[]; edges: Array<{ to: string; columns: string[]; isNullable: boolean }> }> = [];
    const visited = new Set<string>();
    const stack: string[] = [];
    const edgeStack: Array<{ to: string; columns: string[]; isNullable: boolean }> = [];

    function findCycles(node: string) {
      stack.push(node);
      visited.add(node);

      const neighbors = adjList[node] || [];
      for (const edge of neighbors) {
        const neighbor = edge.to;
        const cycleStartIndex = stack.indexOf(neighbor);
        
        if (cycleStartIndex !== -1) {
          // Found a cycle!
          const cycleNodes = stack.slice(cycleStartIndex);
          const cycleEdges = edgeStack.slice(cycleStartIndex);
          cycleEdges.push(edge);
          
          cycles.push({
            nodes: cycleNodes,
            edges: cycleEdges
          });
        } else if (!visited.has(neighbor)) {
          edgeStack.push(edge);
          findCycles(neighbor);
          edgeStack.pop();
        }
      }

      stack.pop();
      visited.delete(node);
    }

    // Run cycle detection starting from each node
    for (const table of tables) {
      const tableName = getTableName(table);
      findCycles(tableName);
    }

    // 4. Helper to normalize cycle representations to filter out duplicates
    // A cycle of [A, B, A] starting at A is the same as starting at B
    const uniqueCycles: Array<{ nodes: string[]; edges: any[] }> = [];
    const seenCycleKeys = new Set<string>();

    for (const cycle of cycles) {
      // Find the index of the lexicographically smallest node
      let minNode = cycle.nodes[0];
      let minIndex = 0;
      for (let i = 1; i < cycle.nodes.length; i++) {
        if (cycle.nodes[i] < minNode) {
          minNode = cycle.nodes[i];
          minIndex = i;
        }
      }

      // Rotate nodes and edges to start with the minNode
      const rotatedNodes = [
        ...cycle.nodes.slice(minIndex),
        ...cycle.nodes.slice(0, minIndex)
      ];
      
      const rotatedEdges = [
        ...cycle.edges.slice(minIndex),
        ...cycle.edges.slice(0, minIndex)
      ];

      const cycleKey = rotatedNodes.join('->');
      if (!seenCycleKeys.has(cycleKey)) {
        seenCycleKeys.add(cycleKey);
        uniqueCycles.push({
          nodes: rotatedNodes,
          edges: rotatedEdges
        });
      }
    }

    console.log(`Detected ${uniqueCycles.length} unique cycles in the database schema:`);
    for (const cycle of uniqueCycles) {
      const path = cycle.nodes.join(' -> ') + ' -> ' + cycle.nodes[0];
      console.log(`Cycle: ${path}`);
      
      // 5. Assert: At least one edge in the cycle must be nullable
      const hasNullableEdge = cycle.edges.some(e => e.isNullable);
      
      if (!hasNullableEdge) {
        console.error(`❌ Deadlock risk! All edges in cycle [${path}] are NOT NULL.`);
        for (let i = 0; i < cycle.nodes.length; i++) {
          const from = cycle.nodes[i];
          const to = cycle.nodes[(i + 1) % cycle.nodes.length];
          const edge = cycle.edges[i];
          console.error(`  - Edge ${from} -> ${to} via column(s) [${edge.columns.join(', ')}] is NOT NULL.`);
        }
        expect.fail(`Schema deadlock risk: Directed cycle [${path}] contains zero nullable foreign keys. Database insertions will deadlock.`);
      } else {
        console.log(`  - OK (Cycle is resolvable. Contains nullable foreign key(s))`);
      }
    }
  });
});

