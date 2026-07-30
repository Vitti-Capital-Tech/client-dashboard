"use client";

import React, { useState, useTransition, useRef } from "react";
import {
  parsePnlFileAction,
  exportPnlXlsxAction,
  exportPnlCsvAction,
} from "@/app/actions/pnl-calculator";
import type { ParseResult, PnlSummaryItem } from "@/lib/pnl-calculator";

export function PnlCalculatorClient() {
  const [file, setFile] = useState<File | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isProcessing, startProcessing] = useTransition();
  const [isExportingXlsx, startExportingXlsx] = useTransition();
  const [isExportingCsv, startExportingCsv] = useTransition();
  const [result, setResult] = useState<ParseResult | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<"all" | "matched" | "profit" | "loss" | "options">("all");

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const droppedFile = e.dataTransfer.files[0];
      if (
        droppedFile.name.endsWith(".xlsx") ||
        droppedFile.name.endsWith(".xls") ||
        droppedFile.name.endsWith(".csv")
      ) {
        setFile(droppedFile);
      }
    }
  };

  const handleProcessFile = () => {
    if (!file) return;
    startProcessing(async () => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await parsePnlFileAction(formData);
      setResult(res);
    });
  };

  const handleReset = () => {
    setFile(null);
    setResult(null);
    setSearchQuery("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleDownloadXlsx = () => {
    if (!result || !result.summary.length) return;
    startExportingXlsx(async () => {
      const { base64, filename } = await exportPnlXlsxAction(result.summary);
      const binary = atob(base64);
      const array = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        array[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([array], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    });
  };

  const handleDownloadCsv = () => {
    if (!result || !result.summary.length) return;
    startExportingCsv(async () => {
      const { csv, filename } = await exportPnlCsvAction(result.summary);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    });
  };

  const handleDownloadSample = () => {
    const sampleCsv = `CNote,Account,Type,Security,Company,Description,Contract Date,Adviser,Units,Avg Price,Consideration,Brokerage,Other Charges,GST,Value,Brokerage%,Status
2462073,114716,SELL,EOS,ELECTRO C FPO,,21-05-2026,VIZ,407,8.11,3300.77,100,0,10,3300.77,3.0296,SETTLED
2458396,114716,BUY,EOS,ELECTRO C FPO,,19-05-2026,VIZ,407,8.00,3256.00,0,0,0,3256.00,0,SETTLED
2306306,114716,SELL,LDX,LUMOS DIA FPO,,04-02-2026,VIZ,16629,0.275,4572.98,100,0,10,4462.98,2.1868,SETTLED
2303464,114716,BUY,ACWXX,ACTINOGE INSTOPLACE,,03-02-2026,VIZ,71429,0.042,3000.02,0,0,0,3000.02,0,SETTLED
2288637,114716,BUY,LDX,LUMOS DIA FPO,,23-01-2026,VIZ,16629,0.235,3907.82,100,0,10,4017.82,2.559,SETTLED`;

    const blob = new Blob([sampleCsv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "trade-ledger-sample.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const fmtCurrency = (num: number) => {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num);
  };

  const fmtPrice = (num: number) => {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(num);
  };

  const fmtQty = (num: number) => {
    return num.toLocaleString("en-AU");
  };

  // Filtered rows
  const filteredSummary = (result?.summary || []).filter((item) => {
    const matchesSearch =
      item.ticker.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.company.toLowerCase().includes(searchQuery.toLowerCase());

    if (!matchesSearch) return false;

    if (filterType === "matched") return item.isMatched;
    if (filterType === "profit") return item.isMatched && item.pnlCalculated > 0;
    if (filterType === "loss") return item.isMatched && item.pnlCalculated < 0;
    if (filterType === "options") return item.isOption;
    return true;
  });

  const summaryList = result?.summary || [];
  const totalBuyVolume = summaryList.reduce((acc, curr) => acc + curr.totalBuyValue, 0);
  const totalSellVolume = summaryList.reduce((acc, curr) => acc + curr.totalSellValue, 0);

  const tabCounts = {
    all: summaryList.length,
    matched: summaryList.filter((i) => i.isMatched).length,
    profit: summaryList.filter((i) => i.isMatched && i.pnlCalculated > 0).length,
    loss: summaryList.filter((i) => i.isMatched && i.pnlCalculated < 0).length,
    options: summaryList.filter((i) => i.isOption).length,
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header Banner */}
      <div className="bg-paper-1 border border-paper-border rounded-2xl p-6 sm:p-8 relative overflow-hidden shadow-xs">
        <div className="absolute -top-12 -right-12 w-64 h-64 bg-green/5 rounded-full blur-3xl pointer-events-none" />
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 relative z-10">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-navy/5 text-navy text-xs font-semibold uppercase tracking-wider mb-2">
              <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" />
              </svg>
              Admin Tool
            </div>
            <h1 className="text-2.5xl font-disp font-bold text-navy tracking-tight">
              In-Memory PNL Calculator
            </h1>
            <p className="text-mut text-sm max-w-2xl mt-1 leading-relaxed">
              Upload trade contract note Excel or CSV files to instantly parse, calculate, and download ticker-level P&L summaries without saving any data to the database.
            </p>
          </div>
          <button
            onClick={handleDownloadSample}
            className="inline-flex items-center gap-2 text-xs font-semibold text-navy bg-paper-2 hover:bg-paper-border border border-paper-border px-4 py-2.5 rounded-xl transition-all shadow-2xs"
          >
            <svg className="w-4 h-4 text-mut" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Download Sample Template
          </button>
        </div>
      </div>

      {/* File Upload Dropzone Section */}
      {!result && (
        <div className="bg-paper-1 border border-paper-border rounded-2xl p-6 sm:p-10 shadow-xs">
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-2xl p-8 sm:p-12 text-center transition-all cursor-pointer ${
              isDragOver
                ? "border-green bg-green/5"
                : file
                ? "border-navy/40 bg-paper-2"
                : "border-paper-border hover:border-navy/30 bg-paper-2/50"
            }`}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              accept=".xlsx,.xls,.csv"
              className="hidden"
            />

            <div className="w-14 h-14 rounded-2xl bg-paper-1 border border-paper-border flex items-center justify-center mx-auto mb-4 shadow-2xs text-navy">
              <svg className="w-7 h-7 stroke-[1.7]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 0115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>

            {file ? (
              <div className="space-y-2">
                <p className="font-semibold text-navy text-base">{file.name}</p>
                <p className="text-xs text-mut">
                  {(file.size / 1024).toFixed(1)} KB · Ready for parsing
                </p>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFile(null);
                  }}
                  className="text-xs font-semibold text-loss hover:underline pt-1 inline-block"
                >
                  Remove & pick another file
                </button>
              </div>
            ) : (
              <div className="space-y-1.5">
                <p className="font-semibold text-navy text-base">
                  Drag and drop your trade ledger file here
                </p>
                <p className="text-xs text-mut">
                  Supports <span className="font-medium text-navy">.xlsx</span>, <span className="font-medium text-navy">.xls</span>, or <span className="font-medium text-navy">.csv</span> contract note exports
                </p>
                <p className="text-2xs text-mut/80 pt-2">
                  (Columns expected: Security, Type, Units, Avg Price / Value, CNote, Status)
                </p>
              </div>
            )}
          </div>

          <div className="mt-6 flex justify-end gap-3">
            {file && (
              <button
                type="button"
                onClick={handleProcessFile}
                disabled={isProcessing}
                className="inline-flex items-center gap-2 font-semibold text-white bg-navy hover:bg-navy-h border border-transparent px-6 py-3 rounded-xl transition-all shadow-sm disabled:opacity-50 cursor-pointer"
              >
                {isProcessing ? (
                  <>
                    <svg className="animate-spin w-4 h-4 text-white" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Parsing File...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 7h6m-6 4h6m-6 4h4M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
                    </svg>
                    Calculate PNL Summary
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Parsing Errors Banner */}
      {result && result.errors.length > 0 && (
        <div className="bg-loss-bg/30 border border-loss/20 rounded-2xl p-5 text-sm text-loss flex items-start gap-3">
          <svg className="w-5 h-5 flex-none mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <p className="font-semibold">Processing Issue</p>
            <ul className="list-disc list-inside mt-1 space-y-1 text-xs">
              {result.errors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* KPI Cards & Results View */}
      {result && (
        <div className="space-y-6">
          {/* Metrics Overview */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Total PNL */}
            <div className="bg-paper-1 border border-paper-border rounded-2xl p-5 shadow-2xs space-y-1">
              <span className="text-2xs font-semibold uppercase tracking-wider text-mut">
                Total Net PNL
              </span>
              <p className={`text-2xl font-bold tracking-tight ${result.totalPnl >= 0 ? "text-green" : "text-loss"}`}>
                {fmtCurrency(result.totalPnl)}
              </p>
              <p className="text-xs text-mut">
                {result.matchedTickers} matched ({tabCounts.profit} profit, {tabCounts.loss} loss)
              </p>
            </div>

            {/* Total Trades */}
            <div className="bg-paper-1 border border-paper-border rounded-2xl p-5 shadow-2xs space-y-1">
              <span className="text-2xs font-semibold uppercase tracking-wider text-mut">
                Parsed Trades
              </span>
              <p className="text-2xl font-bold tracking-tight text-navy">
                {result.totalTrades}
              </p>
              <p className="text-xs text-mut">Contract notes parsed</p>
            </div>

            {/* Total Buy Volume */}
            <div className="bg-paper-1 border border-paper-border rounded-2xl p-5 shadow-2xs space-y-1">
              <span className="text-2xs font-semibold uppercase tracking-wider text-mut">
                Total Buy Expenditure
              </span>
              <p className="text-2xl font-bold tracking-tight text-navy">
                {fmtCurrency(totalBuyVolume)}
              </p>
              <p className="text-xs text-mut">Sum of buy consideration</p>
            </div>

            {/* Total Sell Volume */}
            <div className="bg-paper-1 border border-paper-border rounded-2xl p-5 shadow-2xs space-y-1">
              <span className="text-2xs font-semibold uppercase tracking-wider text-mut">
                Total Sell Proceeds
              </span>
              <p className="text-2xl font-bold tracking-tight text-navy">
                {fmtCurrency(totalSellVolume)}
              </p>
              <p className="text-xs text-mut">Sum of sell proceeds</p>
            </div>
          </div>

          {/* Action & Filter Toolbar */}
          <div className="bg-paper-1 border border-paper-border rounded-2xl p-4 sm:p-5 space-y-3.5 shadow-2xs">
            {/* Filter Pills Bar — Full width on Desktop so all 5 tabs fit with ZERO scrolling */}
            <div className="flex items-center gap-1.5 bg-paper-2/90 p-1.5 rounded-2xl border border-paper-border text-xs font-medium overflow-x-auto lg:overflow-visible flex-wrap sm:flex-nowrap shadow-inner">
              {(["all", "matched", "profit", "loss", "options"] as const).map((f) => {
                const active = filterType === f;
                const count = tabCounts[f];
                const labels = {
                  all: "All Tickers",
                  matched: "Matched P&L",
                  profit: "Profit Only",
                  loss: "Loss Only",
                  options: "Options / Unmatched",
                };
                return (
                  <button
                    key={f}
                    onClick={() => setFilterType(f)}
                    className={`flex-1 sm:flex-initial flex items-center justify-center gap-2 px-3.5 py-2 rounded-xl transition-all duration-150 text-xs font-semibold whitespace-nowrap cursor-pointer ${
                      active
                        ? "bg-navy text-white shadow-xs"
                        : "text-mut hover:text-navy hover:bg-paper-1/70"
                    }`}
                  >
                    <span>{labels[f]}</span>
                    <span
                      className={`px-1.5 py-0.5 rounded-md text-3xs font-bold transition-colors ${
                        active
                          ? "bg-white/20 text-white"
                          : "bg-paper-border/80 text-navy/80"
                      }`}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Controls Row: Search Input on left, Export & Action Buttons on right */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
              {/* Search Bar */}
              <div className="relative flex-1 max-w-md">
                <svg className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-mut" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  placeholder="Search ticker or company..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-paper-2 border border-paper-border rounded-xl pl-9 pr-8 py-2 text-xs text-navy focus:outline-none focus:border-navy focus:bg-paper-1 transition-all"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery("")}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-mut hover:text-navy p-0.5"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>

              {/* Download Export Buttons & Reset */}
              <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
                <button
                  onClick={handleDownloadXlsx}
                  disabled={isExportingXlsx}
                  className="inline-flex items-center gap-2 text-xs font-semibold text-white bg-green hover:bg-green-h px-4 py-2 rounded-xl transition-all shadow-2xs cursor-pointer disabled:opacity-50"
                  title="Export as Microsoft Excel (.xlsx)"
                >
                  {isExportingXlsx ? (
                    "Exporting..."
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      Excel (.xlsx)
                    </>
                  )}
                </button>

                <button
                  onClick={handleDownloadCsv}
                  disabled={isExportingCsv}
                  className="inline-flex items-center gap-2 text-xs font-semibold text-navy bg-paper-2 hover:bg-paper-border border border-paper-border px-3.5 py-2 rounded-xl transition-all shadow-2xs cursor-pointer disabled:opacity-50"
                  title="Export as CSV (.csv)"
                >
                  {isExportingCsv ? (
                    "Exporting..."
                  ) : (
                    <>
                      <svg className="w-4 h-4 text-mut" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      CSV (.csv)
                    </>
                  )}
                </button>

                <button
                  onClick={handleReset}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-mut hover:text-loss border border-paper-border hover:border-loss/30 px-3 py-2 rounded-xl transition-all cursor-pointer"
                  title="Reset & upload new trade ledger file"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  New
                </button>
              </div>
            </div>
          </div>

          {/* Results Summary Table */}
          <div className="bg-paper-1 border border-paper-border rounded-2xl overflow-hidden shadow-2xs">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-paper-2 text-navy border-b border-paper-border text-2xs font-semibold uppercase tracking-wider">
                    <th className="py-3.5 px-4">Ticker</th>
                    <th className="py-3.5 px-4">Company</th>
                    <th className="py-3.5 px-4 text-right">Buy Qty (Sum)</th>
                    <th className="py-3.5 px-4 text-right">Sell Qty (Sum)</th>
                    <th className="py-3.5 px-4 text-right">Buy Price (Sum)</th>
                    <th className="py-3.5 px-4 text-right">Sell Price (Sum)</th>
                    <th className="py-3.5 px-4 text-right">PnL Calculated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-paper-border text-xs">
                  {filteredSummary.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-12 text-center text-mut">
                        No ticker records found matching your filters.
                      </td>
                    </tr>
                  ) : (
                    filteredSummary.map((item) => (
                      <tr key={item.ticker} className="hover:bg-paper-2/60 transition-colors">
                        <td className="py-3.5 px-4 font-bold text-navy">
                          <div className="flex items-center gap-2">
                            <span>{item.ticker}</span>
                            {item.isOption ? (
                              <span className="text-3xs px-1.5 py-0.5 rounded bg-amber-bg text-amber-d font-semibold" title="Unmatched buy/sell quantities - categorized under options">
                                Option ({fmtQty(Math.abs(item.openQty))})
                              </span>
                            ) : (
                              <span className="text-3xs px-1.5 py-0.5 rounded bg-green-bg text-green-d font-semibold">
                                Matched
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3.5 px-4 text-mut truncate max-w-[200px]" title={item.company}>
                          {item.company}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono text-navy">
                          {fmtQty(item.buyQty)}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono text-navy">
                          {fmtQty(item.sellQty)}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono text-navy">
                          {fmtCurrency(item.buyPrice)}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono text-navy">
                          {fmtCurrency(item.sellPrice)}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono font-bold">
                          {item.isMatched ? (
                            <span
                              className={`inline-block px-2.5 py-1 rounded-lg ${
                                item.pnlCalculated > 0
                                  ? "bg-green-bg text-green-d"
                                  : item.pnlCalculated < 0
                                  ? "bg-loss-bg text-loss-d"
                                  : "bg-paper-2 text-mut"
                              }`}
                            >
                              {fmtCurrency(item.pnlCalculated)}
                            </span>
                          ) : (
                            <span className="inline-block px-2 py-1 rounded-lg bg-paper-2 text-mut font-normal text-2xs italic">
                              Option (Excluded)
                            </span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                {filteredSummary.length > 0 && (
                  <tfoot>
                    <tr className="bg-paper-2 font-bold text-navy border-t border-paper-border text-xs">
                      <td className="py-4 px-4" colSpan={2}>
                        Matched Grand Total ({tabCounts.matched} matched tickers)
                      </td>
                      <td className="py-4 px-4 text-right font-mono">
                        {fmtQty(filteredSummary.filter((i) => i.isMatched).reduce((s, i) => s + i.buyQty, 0))}
                      </td>
                      <td className="py-4 px-4 text-right font-mono">
                        {fmtQty(filteredSummary.filter((i) => i.isMatched).reduce((s, i) => s + i.sellQty, 0))}
                      </td>
                      <td className="py-4 px-4 text-right font-mono">
                        {fmtCurrency(filteredSummary.filter((i) => i.isMatched).reduce((s, i) => s + i.buyPrice, 0))}
                      </td>
                      <td className="py-4 px-4 text-right font-mono">
                        {fmtCurrency(filteredSummary.filter((i) => i.isMatched).reduce((s, i) => s + i.sellPrice, 0))}
                      </td>
                      <td className="py-4 px-4 text-right font-mono">
                        <span
                          className={`inline-block px-2.5 py-1 rounded-lg ${
                            result.totalPnl >= 0 ? "bg-green-bg text-green-d" : "bg-loss-bg text-loss-d"
                          }`}
                        >
                          {fmtCurrency(result.totalPnl)}
                        </span>
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
