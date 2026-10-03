// リソース定義。列名は migrations/*.sql のテーブル定義と同一にすること(列を足すときは両方を直す)。
// 0001 以降の全 migrations(0002 の追加列、0003 の削除列を含む)を足し合わせた結果と一致させること。

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
  guides: {
    table: 'guides',
    idPrefix: 'gd_',
    jsonFields: [],
    adminOnly: false,
    adminWrite: true,   // 閲覧はメンバーも可。作成・編集(save)・削除は管理者のみ
    columns: ["ID", "Title", "Icon", "ParentID", "SortOrder", "Body", "CreatedAt", "UpdatedAt"]
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
