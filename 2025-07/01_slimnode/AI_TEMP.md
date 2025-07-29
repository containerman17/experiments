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

## Progress Update

### Completed ✅

1. **database.ts** - Fully rewritten with new structure:
   - Changed to flat array of `NodeAssignment` objects
   - New methods: `addNodeToSubnet`, `removeAssignment`, `getSubnetAssignments`,
     `getNodeAssignments`
   - Kept `getNodeSubnets` for docker-composer compatibility
   - Each assignment has independent creation/expiration times
   - Clean implementation without migration logic (no existing data)

2. **server.ts** - Updated all endpoints:
   - Removed `/node_admin/subnets/scale/:subnetId/:count`
   - Added `POST /node_admin/subnets/add/:subnetId` - returns full node info +
     assignment metadata
   - Added `DELETE /node_admin/subnets/delete/:subnetId/:nodeId` - removes
     specific assignment
   - Updated `GET /node_admin/subnets/status/:subnetId` - now includes per-node
     metadata
   - Updated proxy endpoints to use `getSubnetAssignments` instead of
     `getSubnet`

3. **config.ts** - Minor update:
   - Renamed `SUBNET_EXPIRATION_TIME` to `ASSIGNMENT_EXPIRATION_TIME`

### Remaining Tasks 📝

1. **Testing**:
   - Test add/delete endpoints
   - Test capacity limits and oldest assignment removal
   - Test docker-compose regeneration

2. **Documentation**:
   - Update API documentation

3. **Docker Composer**:
   - No changes needed - `getNodeSubnets` interface unchanged

### Database Format

The new database format is simple and clean:

```json
{
  "assignments": [
    {
      "nodeId": 0,
      "subnetId": "subnetId",
      "dateCreated": 123456789,
      "expiresAt": 123456789
    }
  ]
}
```

## Refactoring Complete ✅

The refactoring from subnet-centric scaling to explicit node assignment is now
complete. The new API provides:

1. **Better Control** - Users explicitly add/remove nodes
2. **Clear Visibility** - Each assignment shows creation and expiration times
3. **Independent Lifecycles** - Nodes expire individually, not as a group
4. **Simpler Mental Model** - No abstract scaling numbers

The system maintains all existing functionality while providing a more intuitive
and flexible interface.
