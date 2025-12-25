import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * CRIPFCnt Placement SCOI Audit Schema
 * Immutable, historical, non-retroactive
 */

const PlacementAuditSchema = new Schema(
  {
    framework: {
      type: String,
      default: "CRIPFCnt SCOI",
      immutable: true
    },

    auditType: {
      type: String,
      enum: ["placement"],
      required: true,
      immutable: true
    },

    matrix: {
      type: String,
      enum: ["dual"],
      default: "dual",
      immutable: true
    },

    subject: {
      name: {
        type: String,
        required: true,
        index: true
      },
      entityType: {
        type: String,
        enum: ["organization", "individual", "system", "concept"],
        required: true
      }
    },

    assessmentWindow: {
      label: {
        type: String, // e.g. "September 2022"
        required: true,
        index: true
      },
      startDate: {
        type: Date
      },
      endDate: {
        type: Date
      }
    },
    isPaid: {
  type: Boolean,
  default: false
}
,
pdfUrl: {
  type: String
}
,
    status: {
  type: String,
  enum: ["archived_reference", "active_reference"],
  default: "archived_reference",
  immutable: true
},

revisionPolicy: {
  type: String,
  enum: ["fixed", "rolling"],
  default: "fixed",
  immutable: true
},


    author: {
      type: String,
      default: "Donald Mataranyika",
      immutable: true
    },

    purpose: {
      type: String,
      required: true
    },

    context: {
      period: {
        type: String
      },
      conditions: {
        type: [String]
      }
    },

    scores: {
      visibility: {
        value: {
          type: Number,
          required: true,
          min: 0,
          max: 10
        },
        scale: {
          type: Number,
          default: 10,
          immutable: true
        },
        definition: {
          type: String
        },
        narrative: {
          type: String
        },
        interpretation: {
          type: String
        }
      },

      contribution: {
        value: {
          type: Number,
          required: true,
          min: 0,
          max: 10
        },
        scale: {
          type: Number,
          default: 10,
          immutable: true
        },
        definition: {
          type: String
        },
        narrative: {
          type: String
        },
        limitations: {
          type: [String]
        },
        interpretation: {
          type: String
        }
      }
    },

    calculations: {
      placementSCOI: {
        formula: {
          type: String,
          default: "Contribution ÷ Visibility",
          immutable: true
        },
        value: {
          type: Number,
          required: true
        },
        working: {
          type: String
        },
        meaning: {
          type: String
        }
      },

      gridSCOI: {
        formula: {
          type: String,
          default: "Visibility ÷ Contribution",
          immutable: true
        },
        value: {
          type: Number,
          required: true
        },
        working: {
          type: String
        },
        meaning: {
          type: String
        }
      }
    },

    structuralDiagnosis: {
      type: String
    },

    finalPlacementStatement: {
      type: String
    },

    temporalNotice: {
      type: String
    },

    confidenceLevel: {
      type: String,
      enum: ["high", "moderate", "experimental"],
      default: "high"
    },

    citations: {
      type: [String]
    },

    relatedAudits: [
      {
        type: Schema.Types.ObjectId,
        ref: "PlacementAudit"
      }
    ],

    createdAt: {
      type: Date,
      default: Date.now,
      immutable: true
    }
  },
  {
    collection: "placement_audits",
    strict: true
  }
);

export default mongoose.model("PlacementAudit", PlacementAuditSchema);
