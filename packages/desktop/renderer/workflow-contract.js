import { $, fill, h } from "./dom.js";
import { t } from "./i18n.js";
import { markdownView } from "./content.js";

const own = (value, key) => value !== undefined && Object.hasOwn(value, key);
const printed = (value) => JSON.stringify(value, null, 2);
const valueView = (value) => h("pre", {}, typeof value === "string" && value ? value : printed(value));
const section = (title, ...content) => h("section", { "data-part": title }, h("h4", {}, t("flow." + title)), ...content);
function typeAndDescription(schema) {
  const type = schema?.type;
  return [Array.isArray(type) ? type.join(" | ") : type, schema?.description].filter(Boolean).join(" · ");
}

function schemaDetails(node, edges, openLink, rawOpen) {
  const { goal, inputSchema, fixedInput, input, inputSources, schema, result, error } = node.contract;
  const bindings = edges.filter(edge => edge.to === node.name && edge.bind);
  const planned = new Map();
  for (const edge of bindings) {
    for (const [field, pointer] of Object.entries(edge.bind)) {
      if (!planned.has(field)) planned.set(field, []);
      planned.get(field).push([edge.from, pointer || t("flow.wholeResult"), edge.case].filter(Boolean).join(" · "));
    }
  }
  const fields = new Set([...Object.keys(inputSchema.properties ?? {}), ...Object.keys(fixedInput ?? {}), ...planned.keys(), ...Object.keys(input ?? {})]);
  const rows = Array.from(fields, (name) => {
    const actual = own(input, name);
    const fixed = own(fixedInput, name);
    const source = own(inputSources, name) && inputSources[name];
    const fieldSchema = own(inputSchema.properties, name) && inputSchema.properties[name];
    let sources = planned.get(name) ?? [];
    if (source) sources = [[source.node, source.pointer || t("flow.wholeResult"), source.delivery].join(" · ")];
    else if (fixed) sources = [t("flow.fixed")];
    else if (input !== undefined) sources = [];
    return h("div", { class: "contract-field" },
      h("strong", {}, name),
      h("small", {}, [typeAndDescription(fieldSchema), t(inputSchema.required?.includes(name) ? "flow.required" : "flow.optional")].filter(Boolean).join(" · ")),
      ...sources.map(source => h("div", { class: "contract-source" }, t("flow.source") + " · " + source)),
      actual ? valueView(input[name]) : fixed ? valueView(fixedInput[name]) : input !== undefined && h("small", {}, t("flow.absent")));
  });
  // The end publishes its named input object. Its input schema describes that delivery.
  const expected = schema ?? (node.kind === "end" ? inputSchema : undefined);
  const raw = { inputSchema, schema, fixedInput, bindings, input, inputSources, result };
  return h("div", { class: "contract-body" },
    error && h("p", { class: "error", role: "alert" }, error),
    goal && section("goal", h("p", {}, goal)),
    section("inputs", ...(rows.length ? rows : [h("p", {}, t("flow.noFields"))])),
    expected && section("expected", h("p", {}, typeAndDescription(expected) || printed(expected)),
      ...Object.entries(expected.properties ?? {}).map(([name, property]) =>
        h("div", { class: "contract-field" }, h("strong", {}, name),
          h("small", {}, [typeAndDescription(property), t(expected.required?.includes(name) ? "flow.required" : "flow.optional")].filter(Boolean).join(" · "))))),
    result !== undefined && section("result", valueView(result)),
    node.summary && section("nodeSummary", markdownView(node.summary, openLink)),
    h("details", { class: "contract-raw", open: rawOpen }, h("summary", {}, t("flow.raw")), h("pre", {}, printed(raw))));
}

function markdownDetails(node, edges, openLink, sourcesOpen) {
  const { requirements, entryInput, input, sources, output, choice } = node.markdown;
  const cases = edges.filter(edge => edge.from === node.name && edge.case !== undefined);
  const incoming = input === undefined && [...new Set(edges.filter(edge => edge.to === node.name).map(edge => edge.from))];
  return h("div", { class: "contract-body" },
    requirements !== undefined && section("requirements", markdownView(requirements, openLink)),
    input === undefined && entryInput !== undefined && section("entryInput", markdownView(entryInput, openLink)),
    incoming?.length > 0 && section("dependencies", ...incoming.map(name => h("div", {}, name))),
    input !== undefined && section("assignedInput", markdownView(input, openLink),
      !!sources?.length && h("details", { class: "input-sources", open: sourcesOpen },
        h("summary", {}, t("flow.inputSources")),
        ...sources.map(s => h("div", { class: "contract-source", title: s.delivery }, s.node)))),
    output !== undefined && section("result", markdownView(output, openLink)),
    cases.length > 0 && section("candidates", ...cases.map(c =>
      h("div", { class: "contract-field" }, h("strong", {}, c.to), markdownView(c.case, openLink)))),
    choice !== undefined && section("selectedTarget", h("p", {}, choice)),
    !!node.additionalResults?.length && section("extraResults", ...node.additionalResults.map(r => markdownView(r.summary, openLink))));
}

/** Read the selected graph version and its accepted values directly; display never parses an assignment. */
export function renderContract(flow, version, node, edges, openLink, stopButton) {
  const panel = $("#flow-contract");
  if (!node) {
    panel.hidden = true;
    if (panel.workflow) fill(panel);
    panel.workflow = undefined;
    return;
  }
  const sameNode = panel.dataset.version === version && panel.dataset.node === node.name && panel.workflow?.sessionId === flow.sessionId;
  if (sameNode && panel.workflow === flow && !!stopButton === !!panel.querySelector("[data-action=stop-node]")) return;
  const top = sameNode ? panel.scrollTop : 0;
  fill(panel, h("summary", {}, t("flow.details", { name: node.name })),
    node.markdown ? markdownDetails(node, edges, openLink, sameNode && panel.querySelector(".input-sources")?.open)
      : node.contract ? schemaDetails(node, edges, openLink, sameNode && panel.querySelector(".contract-raw")?.open)
      : h("p", {}, t("flow." + node.status)),
    stopButton);
  if (!sameNode) panel.open = false;
  panel.dataset.version = version;
  panel.dataset.node = node.name;
  panel.workflow = flow;
  panel.hidden = false;
  panel.scrollTop = top;
}
