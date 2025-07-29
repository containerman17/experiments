# Refactoring Plan: Node-Centric Assignment Model

## Overview

Moving from subnet-centric scaling model to explicit node assignment model with
per-assignment lifecycle tracking.

## Database Changes (database.ts)

### New Structure

```typescript
type NodeAssignment = {
    nodeId: number;
    subnetId: string;
    dateCreated: number;
    expiresAt: number;
};

interface NodeDatabase {
    assignments: NodeAssignment[];
}
```

### Methods to Implement

- `addNodeToSubnet(subnetId: string): NodeAssignment` - Find available slot,
  create assignment
- `removeAssignment(subnetId: string, nodeId: number): boolean` - Remove
  specific assignment
- `getSubnetAssignments(subnetId: string): NodeAssignment[]` - Filter by subnet
- `getNodeAssignments(nodeId: number): NodeAssignment[]` - Filter by node
- `getNodeSubnets(nodeId: number): string[]` - For docker-compose generation
  (unchanged interface)
- `private findAvailableNode(excludeNodes: number[]): number | null` - Find node
  with capacity
- `private removeOldestAssignment(): void` - When no slots available

### Key Logic Changes

- Remove `addOrAdjustSubnet` completely
- Simplify slot finding - just need one available node
- Each assignment manages its own expiration
- File format: `{"assignments": [...]}`

## Server Changes (server.ts)

### Remove

- `/node_admin/subnets/scale/:subnetId/:count` endpoint

### Add New Endpoints

```typescript
// POST /node_admin/subnets/add/:subnetId
// Returns: { nodeId, nodeInfo, dateCreated, expiresAt }
// - Validates subnet exists
// - Adds one node
// - Returns full node info + assignment details

// DELETE /node_admin/subnets/delete/:subnetId/:nodeId
// Returns: { success: boolean }
// - Removes specific assignment
// - Regenerates docker-compose

// GET /node_admin/subnets/status/:subnetId (modify existing)
// Returns: { subnetId, nodes: [{ nodeId, nodeInfo, dateCreated, expiresAt }] }
// - Include assignment metadata for each node
```

## Docker Composer Changes (docker-composer.ts)

### Minimal Changes

- `getNodeSubnets()` interface stays the same
- Logic remains unchanged - still generates based on which nodes track which
  subnets

## Other Files

### config.ts

- Keep `SUBNET_EXPIRATION_TIME` but rename to `ASSIGNMENT_EXPIRATION_TIME`
- Rest unchanged

### node_apis.ts

- No changes needed

### rate-limiter.ts

- No changes needed

## Migration Notes

### Data Migration

- On first load, convert existing format:
  ```typescript
  // Old: { [subnetId]: { nodeIds: [], dateCreated, expiresAt } }
  // New: { assignments: [{ nodeId, subnetId, dateCreated, expiresAt }] }
  ```

### Testing Plan

1. Test add endpoint - verify node assignment and response
2. Test delete endpoint - verify specific node removal
3. Test status endpoint - verify all metadata included
4. Test capacity limits - ensure respects SUBNETS_PER_NODE
5. Test expiration - verify oldest assignments removed when full

## Benefits

1. **Explicit Control**: Users know exactly which node they're getting/removing
2. **Independent Lifecycles**: Each assignment has its own expiration
3. **Better Visibility**: Status shows when each node was added
4. **Simpler Logic**: No complex rebalancing or count adjustments
5. **Future Proof**: Easy to add per-assignment metadata later

## Risks

1. **Breaking Change**: Existing deployments need data migration
2. **More API Calls**: Users need multiple adds instead of one scale
3. **Database Size**: Slightly larger with repeated metadata

## Implementation Order

1. Create new database.ts with backward-compatible loader
2. Update server.ts endpoints
3. Test thoroughly
4. Update any documentation
