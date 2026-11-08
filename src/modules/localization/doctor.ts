/**
 * Doctor phone view strings (docs/design/doctor-view.md). Strings that are
 * identical to the reception console (call next, start, complete, pause,
 * resume, delay, no-show, reason, paused banner) are reused from
 * `receptionistCopy`; only doctor-specific keys live here.
 */
export const doctorCopy = {
  fr: {
    title: 'Ma file',
    inConsultTitle: 'En consultation',
    calledTitle: 'Appelé, en route vers vous',
    noCurrent: 'Aucun patient en consultation',
    noShowAsk: 'Le patient ne se présente pas',
    noShowConfirm: 'Confirmer l’absence',
    cancelPanel: 'Annuler',
    nextTitle: 'Ensuite',
    nextEmpty: 'Personne n’est arrivé pour le moment.',
    notArrived: '{n} pas encore arrivés',
    today: 'Aujourd’hui : {done} terminées · {absent} absents',
  },
  ar: {
    title: 'قائمتي',
    inConsultTitle: 'في الاستشارة',
    calledTitle: 'تم النداء، في الطريق إليك',
    noCurrent: 'لا يوجد مريض في الاستشارة',
    noShowAsk: 'المريض لم يحضر',
    noShowConfirm: 'تأكيد عدم الحضور',
    cancelPanel: 'إلغاء',
    nextTitle: 'التالي',
    nextEmpty: 'لم يصل أي مريض حتى الآن.',
    notArrived: '{n} لم يصلوا بعد',
    today: 'اليوم: {done} منتهية · {absent} لم يحضروا',
  },
} as const;
