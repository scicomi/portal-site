// リソース定義。列名は gas/Code.gs の *_HEADERS と同一(スプレッドシート時代の列名を維持)。
// migrations/0001_init.sql のテーブル定義と一致させること。

export const RESOURCES = {
  events: {
    table: 'events',
    idPrefix: 'ev_',
    jsonFields: ["PartsList", "Files", "PrAssignments", "RequestDoc", "KyokaDoc", "HoukokuDoc", "MeetingDocs", "Minutes"],
    adminOnly: false,
    columns: ["ID", "Date", "DateEnd", "Title", "Category", "Location", "Audience", "Address", "PostalCode", "LocationTel", "EmergencyHospital", "EmergencyPolice", "TimeStart", "TimeEnd", "GatherTime", "DismissTime", "MeetingNumber", "PartsList", "AdminKyoka", "AdminHoukoku", "KyokaDeadline", "HoukokuDeadline", "KyokaNotRequired", "HoukokuNotRequired", "VoteDeadline", "PlanName", "Remarks", "Files", "Belongings", "Accompany", "SeriesKey", "Positives", "Reflections", "ResultsMemo", "VisitorCount", "ParticipantCount", "PrAssignments", "ReportStatus", "KyokaStatus", "PlanLeader", "TransportMethod", "TransportDriver", "TransportPassengers", "RequestDoc", "KyokaDoc", "HoukokuDoc", "MeetingDocs", "Minutes", "CreatedAt", "UpdatedAt", "UpdatedBy"]
  },
  members: {
    table: 'members',
    idPrefix: 'mb_',
    jsonFields: [],
    adminOnly: false,
    columns: ["ID", "Name", "Furigana", "Category", "Role", "StudentID", "Affiliation", "Email", "Extension", "EmergencyContact", "Note", "FiscalYear", "Active", "CreatedAt", "UpdatedAt"]
  },
  experiments: {
    table: 'experiments',
    idPrefix: 'ex_',
    jsonFields: [],
    adminOnly: false,
    columns: ["ID", "Name", "Category", "Materials", "Preparation", "Flow", "Notes", "SlidesURL", "Sections", "Photos", "Videos", "Reflections", "Positives", "Active", "CreatedAt", "UpdatedAt"]
  },
  passwords: {
    table: 'passwords',
    idPrefix: 'pw_',
    jsonFields: [],
    adminOnly: true,
    columns: ["ID", "Category", "SiteName", "URL", "LoginID", "LoginType", "Password", "Note", "Photos", "CreatedAt", "UpdatedAt"]
  },
};

export function getResource(name) {
  return Object.prototype.hasOwnProperty.call(RESOURCES, name) ? RESOURCES[name] : null;
}
