"use strict";

const risk_rank = {
  low: 1,
  medium: 2,
  high: 3,
};

function filter_rules(
  rules,
  {
    rule_ids = null,
    kind = null,
    risk_ceiling = null,
    enabled_only = true,
  } = {},
) {
  const id_set =
    rule_ids && rule_ids.length > 0 ? new Set(rule_ids) : null;
  const ceiling_rank =
    risk_ceiling == null ? null : risk_rank[String(risk_ceiling)];

  if (risk_ceiling != null && ceiling_rank == null) {
    throw new Error(`Invalid risk ceiling: ${risk_ceiling}`);
  }

  return (rules || []).filter((rule) => {
    if (enabled_only && rule.enabled === false) {
      return false;
    }

    if (id_set && !id_set.has(rule.id)) {
      return false;
    }

    if (kind != null && rule.kind !== kind) {
      return false;
    }

    if (ceiling_rank != null) {
      const rule_risk = risk_rank[String(rule.risk)];
      if (rule_risk == null || rule_risk > ceiling_rank) {
        return false;
      }
    }

    return true;
  });
}

module.exports = {
  filter_rules,
  risk_rank,
};
