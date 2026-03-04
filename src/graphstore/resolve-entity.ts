/**
 * Shared utility to resolve an opaque entity ID string into candidate
 * label + key combinations for lookup against the graph store.
 *
 * Used by the Kuzu adapter and the API server routes.
 */

export interface ResolvedEntity {
  label: string;
  keyExpr: string;
  nameExpr: string;
  key: Record<string, unknown>;
}

export function resolveEntityId(
  entityId: string,
  entityAlias = 'entity',
): ResolvedEntity[] {
  return [
    {
      label: 'Person',
      keyExpr: `${entityAlias}.person_key`,
      nameExpr: `${entityAlias}.display_name`,
      key: { person_key: entityId },
    },
    {
      label: 'Topic',
      keyExpr: `${entityAlias}.name`,
      nameExpr: `${entityAlias}.name`,
      key: { name: entityId },
    },
    {
      label: 'Container',
      keyExpr: `${entityAlias}.source + ':' + ${entityAlias}.container_id`,
      nameExpr: `${entityAlias}.name`,
      key: (() => {
        const idx = entityId.indexOf(':');
        return idx > 0
          ? { source: entityId.slice(0, idx), container_id: entityId.slice(idx + 1) }
          : { container_id: entityId };
      })(),
    },
  ];
}
