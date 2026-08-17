// Plain-language labels and one-sentence explanations for calculated fields, so both
// finance and non-finance staff can use the register without training.
export const FIELD_INFO = {
  grossBlock: {
    label: "Gross Block",
    tooltip: "What the asset originally cost, plus any additions, minus anything sold or scrapped so far."
  },
  accumulatedDepreciation: {
    label: "Accumulated Depreciation",
    tooltip: "The total value written off so far to reflect wear and use, from when the asset was acquired up to today's cut-off date."
  },
  periodDepreciation: {
    label: "Depreciation for This Period",
    tooltip: "The portion of the asset's value written off just for the period ending on the current cut-off date."
  },
  nbv: {
    label: "Net Book Value (NBV)",
    tooltip: "What the asset is still worth on the books: its cost minus everything depreciated so far."
  },
  wdv: {
    label: "Written-Down Value (WDV) at Disposal",
    tooltip: "What the disposed portion of the asset was still worth on the books at the moment it was sold or scrapped."
  },
  profitLoss: {
    label: "Profit / (Loss) on Disposal",
    tooltip: "The difference between what the asset sold for and its Written-Down Value — positive means a gain, negative (in brackets) means a loss."
  },
  effectiveLocation: {
    label: "Current Location",
    tooltip: "Where the asset is as of the cut-off date, accounting for any transfers between centers."
  },
  usefulLife: {
    label: "Useful Life",
    tooltip: "The number of years over which the asset's cost is spread evenly (straight-line) as depreciation."
  }
} as const;
