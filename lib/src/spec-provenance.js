const fields = [
  'identity.name', 'identity.title', 'identity.departmentId', 'identity.managerId', 'identity.avatarId',
  'profileId', 'mission', 'responsibilities', 'successMetrics', 'capabilities', 'tools', 'policies', 'coworkers', 'evaluationPolicy',
];

function fieldValue(spec, field) {
  const [parent, child] = field.split('.');
  return child ? spec?.[parent]?.[child] : spec?.[parent];
}

export function provenanceForEditedFields(original, edited, provenance = []) {
  const changed = new Set(fields.filter((field) => JSON.stringify(fieldValue(original, field)) !== JSON.stringify(fieldValue(edited, field))));
  return [
    ...(Array.isArray(provenance) ? provenance : []).filter((item) => !changed.has(item.field)),
    ...[...changed].map((field) => ({ field, source: 'Manager input', confidence: 1 })),
  ];
}
