"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";

interface Lead {
  id: string;
  name: string;
  email: string;
  company?: string;
  phone?: string;
  source: "manychat" | "manual" | "import";
  status: "new" | "contacted" | "qualified" | "demo_scheduled" | "closed" | "lost";
  lastAction: string;
  lastActionAt: string;
  notes?: string;
  assignedTo?: string;
  tags: string[];
}

const COLUMNS = [
  { id: "new", label: "New Lead", color: "#3b82f6" },
  { id: "contacted", label: "Contacted", color: "#8b5cf6" },
  { id: "qualified", label: "Qualified", color: "#f59e0b" },
  { id: "demo_scheduled", label: "Demo Scheduled", color: "#10b981" },
  { id: "closed", label: "Closed Won", color: "#059669" },
  { id: "lost", label: "Closed Lost", color: "#ef4444" },
] as const;

const MOCK_LEADS: Lead[] = [
  {
    id: "lead_001",
    name: "Juan Perez",
    email: "juan@alalegal.mx",
    company: "ALA Legal",
    phone: "+52 55 1234 5678",
    source: "manychat",
    status: "new",
    lastAction: "Started conversation via Messenger",
    lastActionAt: new Date().toISOString(),
    tags: ["spanish", "legal", "warm"],
  },
  {
    id: "lead_002",
    name: "Maria Garcia",
    email: "maria@ejemplo.com",
    company: "Garcia Consulting",
    source: "manual",
    status: "contacted",
    lastAction: "Sent initial email",
    lastActionAt: new Date(Date.now() - 86400000).toISOString(),
    assignedTo: "admin@superwave.ai",
    tags: ["consulting", "follow-up"],
  },
  {
    id: "lead_003",
    name: "Carlos Rodriguez",
    email: "carlos@empresa.mx",
    source: "manychat",
    status: "qualified",
    lastAction: "Replied with interest",
    lastActionAt: new Date(Date.now() - 172800000).toISOString(),
    notes: "Needs immigration help, budget confirmed",
    tags: ["immigration", "high-value"],
  },
];

export function PipelineKanban() {
  const router = useRouter();
  const [leads, setLeads] = useState<Lead[]>(MOCK_LEADS);
  const [draggedLead, setDraggedLead] = useState<Lead | null>(null);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);

  const handleDragStart = (lead: Lead) => {
    setDraggedLead(lead);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent, status: Lead["status"]) => {
    e.preventDefault();
    if (!draggedLead) return;

    setLeads((prev) =>
      prev.map((lead) =>
        lead.id === draggedLead.id
          ? { ...lead, status, lastAction: `Moved to ${COLUMNS.find(c => c.id === status)?.label}`, lastActionAt: new Date().toISOString() }
          : lead
      )
    );
    setDraggedLead(null);
  };

  const getLeadsByStatus = (status: Lead["status"]) =>
    leads.filter((lead) => lead.status === status);

  const formatTimeAgo = (date: string) => {
    const seconds = Math.floor((new Date().getTime() - new Date(date).getTime()) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  return (
    <div className="h-full flex flex-col bg-stone-50">
      {/* Header */}
      <div className="px-6 py-4 border-b border-stone-200 bg-white">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Sales Pipeline</h1>
            <p className="text-sm text-gray-500 mt-1">
              {leads.length} leads total • {getLeadsByStatus("new").length} new
            </p>
          </div>
          <button
            onClick={() => router.push("/workspace?tab=leads")}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            + Add Lead
          </button>
        </div>
      </div>

      {/* Kanban Board */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden p-6">
        <div className="flex gap-4 h-full min-w-max">
          {COLUMNS.map((column) => {
            const columnLeads = getLeadsByStatus(column.id as Lead["status"]);
            return (
              <div
                key={column.id}
                className="w-80 flex flex-col bg-stone-100 rounded-lg"
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, column.id as Lead["status"])}
              >
                {/* Column Header */}
                <div
                  className="px-4 py-3 rounded-t-lg flex items-center justify-between"
                  style={{ backgroundColor: column.color + "20" }}
                >
                  <div className="flex items-center gap-2">
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: column.color }}
                    />
                    <span className="font-medium text-gray-800">{column.label}</span>
                  </div>
                  <span className="text-sm text-gray-500 bg-white px-2 py-1 rounded-full">
                    {columnLeads.length}
                  </span>
                </div>

                {/* Cards */}
                <div className="flex-1 p-3 overflow-y-auto space-y-3">
                  {columnLeads.map((lead) => (
                    <div
                      key={lead.id}
                      draggable
                      onDragStart={() => handleDragStart(lead)}
                      onClick={() => setSelectedLead(lead)}
                      className="bg-white p-4 rounded-lg shadow-sm border border-stone-200 cursor-pointer hover:shadow-md transition-shadow"
                    >
                      {/* Lead Header */}
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <h3 className="font-medium text-gray-900">{lead.name}</h3>
                          {lead.company && (
                            <p className="text-sm text-gray-500">{lead.company}</p>
                          )}
                        </div>
                        <span
                          className={`text-xs px-2 py-1 rounded-full ${
                            lead.source === "manychat"
                              ? "bg-blue-100 text-blue-700"
                              : "bg-gray-100 text-gray-600"
                          }`}
                        >
                          {lead.source}
                        </span>
                      </div>

                      {/* Last Action */}
                      <p className="text-sm text-gray-600 mb-3 line-clamp-2">
                        {lead.lastAction}
                      </p>

                      {/* Footer */}
                      <div className="flex items-center justify-between text-xs text-gray-500">
                        <span>{formatTimeAgo(lead.lastActionAt)}</span>
                        {lead.assignedTo && (
                          <span className="truncate max-w-[100px]">
                            {lead.assignedTo.split("@")[0]}
                          </span>
                        )}
                      </div>

                      {/* Tags */}
                      {lead.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-3">
                          {lead.tags.slice(0, 3).map((tag) => (
                            <span
                              key={tag}
                              className="text-xs px-2 py-0.5 bg-stone-100 text-stone-600 rounded"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Lead Detail Modal */}
      {selectedLead && (
        <LeadDetailModal
          lead={selectedLead}
          onClose={() => setSelectedLead(null)}
          onUpdate={(updated) =>
            setLeads((prev) =>
              prev.map((l) => (l.id === updated.id ? updated : l))
            )
          }
        />
      )}
    </div>
  );
}

function LeadDetailModal({
  lead,
  onClose,
  onUpdate,
}: {
  lead: Lead;
  onClose: () => void;
  onUpdate: (lead: Lead) => void;
}) {
  const [notes, setNotes] = useState(lead.notes || "");

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl w-full max-w-lg mx-4 shadow-xl">
        <div className="p-6 border-b border-stone-200">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">{lead.name}</h2>
              <p className="text-gray-500">{lead.email}</p>
            </div>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {lead.company && (
            <div>
              <label className="text-sm font-medium text-gray-700">Company</label>
              <p className="text-gray-900">{lead.company}</p>
            </div>
          )}

          {lead.phone && (
            <div>
              <label className="text-sm font-medium text-gray-700">Phone</label>
              <p className="text-gray-900">{lead.phone}</p>
            </div>
          )}

          <div>
            <label className="text-sm font-medium text-gray-700">Source</label>
            <p className="text-gray-900 capitalize">{lead.source}</p>
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700">Status</label>
            <select
              value={lead.status}
              onChange={(e) =>
                onUpdate({
                  ...lead,
                  status: e.target.value as Lead["status"],
                  lastAction: `Status changed to ${COLUMNS.find(c => c.id === e.target.value)?.label}`,
                  lastActionAt: new Date().toISOString(),
                })
              }
              className="mt-1 w-full px-3 py-2 border border-stone-300 rounded-lg"
            >
              {COLUMNS.map((col) => (
                <option key={col.id} value={col.id}>
                  {col.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              className="mt-1 w-full px-3 py-2 border border-stone-300 rounded-lg"
              placeholder="Add notes about this lead..."
            />
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700">Tags</label>
            <div className="flex flex-wrap gap-2 mt-1">
              {lead.tags.map((tag) => (
                <span
                  key={tag}
                  className="px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-sm"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="p-6 border-t border-stone-200 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg"
          >
            Close
          </button>
          <button
            onClick={() => {
              onUpdate({ ...lead, notes });
              onClose();
            }}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
