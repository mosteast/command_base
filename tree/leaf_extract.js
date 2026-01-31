const Tree_model = require("tree-model");

const DEFAULT_CHILDREN_KEY = "children";
const DEFAULT_VALUE_KEY = "value";
const DEFAULT_ROOT_LABEL = "__leaf_extract_root__";

function normalize_options(options = {}) {
  const children_key =
    typeof options.children_key === "string" && options.children_key.trim()
      ? options.children_key.trim()
      : DEFAULT_CHILDREN_KEY;
  const value_key =
    typeof options.value_key === "string" && options.value_key.trim()
      ? options.value_key.trim()
      : DEFAULT_VALUE_KEY;
  const root_label =
    typeof options.root_label === "string" && options.root_label.trim()
      ? options.root_label.trim()
      : DEFAULT_ROOT_LABEL;

  return {
    children_key,
    value_key,
    root_label,
  };
}

function clone_payload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  return { ...payload };
}

function get_node_payload(node_model) {
  if (node_model && node_model.meta && node_model.meta.is_primitive) {
    return node_model.meta.raw_value;
  }
  return clone_payload(node_model ? node_model.payload : {});
}

function normalize_forest(raw_data, options) {
  if (raw_data === undefined) return [];
  if (Array.isArray(raw_data)) {
    return raw_data.map((node) => normalize_node(node, options));
  }
  return [normalize_node(raw_data, options)];
}

function normalize_node(raw_node, options) {
  if (raw_node && typeof raw_node === "object" && !Array.isArray(raw_node)) {
    const children_value = raw_node[options.children_key];
    const payload = { ...raw_node };
    delete payload[options.children_key];

    return {
      payload,
      children: normalize_forest(children_value, options),
      meta: {
        is_primitive: false,
      },
    };
  }

  return {
    payload: {},
    children: [],
    meta: {
      is_primitive: true,
      raw_value: raw_node,
      value_key: options.value_key,
    },
  };
}

function build_tree_model_from_data(input_data, options = {}) {
  const normalized_options = normalize_options(options);
  const tree_model = new Tree_model({ childrenPropertyName: "children" });
  const root_model = {
    payload: {
      [normalized_options.value_key]: normalized_options.root_label,
      __leaf_extract_root: true,
    },
    children: normalize_forest(input_data, normalized_options),
    meta: { is_root: true },
  };

  return {
    root_node: tree_model.parse(root_model),
    input_is_array: Array.isArray(input_data),
    normalized_options,
  };
}

function get_leaf_nodes(root_node) {
  if (!root_node) return [];

  return root_node.all({ strategy: "post" }, (node) => {
    if (node.model && node.model.payload && node.model.payload.__leaf_extract_root) {
      return false;
    }
    return !node.hasChildren();
  });
}

function collect_selected_nodes(leaf_nodes, level) {
  const selected_nodes = new Set();

  for (const leaf_node of leaf_nodes) {
    const path_nodes = leaf_node
      .getPath()
      .filter(
        (node) =>
          !(node.model && node.model.payload && node.model.payload.__leaf_extract_root),
      );

    const tail_nodes = path_nodes.slice(-level);
    for (const path_node of tail_nodes) {
      selected_nodes.add(path_node);
    }
  }

  return selected_nodes;
}

function build_output_node(node_model, child_outputs, options) {
  if (node_model && node_model.meta && node_model.meta.is_primitive) {
    if (!child_outputs || child_outputs.length === 0) {
      return node_model.meta.raw_value;
    }

    const wrapped_payload = {
      [options.value_key]: node_model.meta.raw_value,
    };
    wrapped_payload[options.children_key] = child_outputs;
    return wrapped_payload;
  }

  const payload = clone_payload(node_model.payload || {});
  if (child_outputs && child_outputs.length > 0) {
    payload[options.children_key] = child_outputs;
  }
  return payload;
}

function collect_output_nodes(current_node, selected_nodes, options) {
  const child_nodes = Array.isArray(current_node.children)
    ? current_node.children
    : [];
  const collected_children = [];

  for (const child_node of child_nodes) {
    const child_outputs = collect_output_nodes(child_node, selected_nodes, options);
    if (child_outputs.length > 0) {
      collected_children.push(...child_outputs);
    }
  }

  if (!selected_nodes.has(current_node)) {
    return collected_children;
  }

  const output_node = build_output_node(current_node.model, collected_children, options);
  return [output_node];
}

function extract_leaf_levels(input_data, options = {}) {
  const normalized_options = normalize_options(options);
  const parsed_level = Number(options.level);
  const level =
    Number.isFinite(parsed_level) && parsed_level >= 1
      ? Math.floor(parsed_level)
      : 1;
  const { root_node, input_is_array } = build_tree_model_from_data(
    input_data,
    normalized_options,
  );

  const leaf_nodes = get_leaf_nodes(root_node);
  const selected_nodes = collect_selected_nodes(leaf_nodes, level);
  const output_forest = [];

  for (const child_node of root_node.children || []) {
    output_forest.push(...collect_output_nodes(child_node, selected_nodes, normalized_options));
  }

  const output_data = input_is_array
    ? output_forest
    : output_forest.length > 0
      ? output_forest[0]
      : null;

  return {
    output_data,
    meta: {
      level,
      leaf_count: leaf_nodes.length,
      selected_count: selected_nodes.size,
    },
  };
}

function flatten_tree(input_data, options = {}) {
  const { root_node } = build_tree_model_from_data(input_data, options);
  if (!root_node) return [];

  return root_node.all({ strategy: "pre" }, (node) => {
    if (node.model && node.model.payload && node.model.payload.__leaf_extract_root) {
      return false;
    }
    return true;
  }).map((node) => get_node_payload(node.model));
}

function get_leaf_paths(input_data, options = {}) {
  const { root_node } = build_tree_model_from_data(input_data, options);
  const leaf_nodes = get_leaf_nodes(root_node);

  return leaf_nodes.map((leaf_node) =>
    leaf_node
      .getPath()
      .filter(
        (node) =>
          !(node.model && node.model.payload && node.model.payload.__leaf_extract_root),
      )
      .map((node) => get_node_payload(node.model)),
  );
}

function map_tree(input_data, options = {}, mapper_fn) {
  if (typeof mapper_fn !== "function") {
    throw new Error("map_tree requires a mapper function");
  }

  const { root_node, input_is_array, normalized_options } =
    build_tree_model_from_data(input_data, options);

  function map_nodes(node_list) {
    const mapped_nodes = [];
    for (const node of node_list) {
      const child_nodes = Array.isArray(node.children) ? node.children : [];
      const mapped_children = map_nodes(child_nodes);
      const mapped_payload = mapper_fn(get_node_payload(node.model), node);
      const mapped_is_object =
        mapped_payload && typeof mapped_payload === "object" && !Array.isArray(mapped_payload);

      if (!mapped_is_object) {
        if (mapped_children.length === 0) {
          mapped_nodes.push(mapped_payload);
          continue;
        }
        const wrapped_payload = { [normalized_options.value_key]: mapped_payload };
        wrapped_payload[normalized_options.children_key] = mapped_children;
        mapped_nodes.push(wrapped_payload);
        continue;
      }

      const output_payload = { ...mapped_payload };
      if (mapped_children.length > 0) {
        output_payload[normalized_options.children_key] = mapped_children;
      }
      mapped_nodes.push(output_payload);
    }
    return mapped_nodes;
  }

  const output_forest = map_nodes(root_node.children || []);
  return input_is_array ? output_forest : output_forest[0] ?? null;
}

function filter_tree(input_data, options = {}, predicate_fn) {
  if (typeof predicate_fn !== "function") {
    throw new Error("filter_tree requires a predicate function");
  }

  const { root_node, input_is_array, normalized_options } =
    build_tree_model_from_data(input_data, options);

  function filter_nodes(node_list) {
    const filtered_nodes = [];

    for (const node of node_list) {
      const child_nodes = Array.isArray(node.children) ? node.children : [];
      const filtered_children = filter_nodes(child_nodes);
      const node_payload = get_node_payload(node.model);
      const matches = predicate_fn(node_payload, node);

      if (!matches && filtered_children.length === 0) {
        continue;
      }

      if (!matches) {
        filtered_nodes.push(...filtered_children);
        continue;
      }

      const output_node = build_output_node(
        node.model,
        filtered_children,
        normalized_options,
      );
      filtered_nodes.push(output_node);
    }

    return filtered_nodes;
  }

  const output_forest = filter_nodes(root_node.children || []);
  return input_is_array ? output_forest : output_forest[0] ?? null;
}

module.exports = {
  normalize_options,
  build_tree_model_from_data,
  get_leaf_nodes,
  extract_leaf_levels,
  flatten_tree,
  get_leaf_paths,
  map_tree,
  filter_tree,
};
