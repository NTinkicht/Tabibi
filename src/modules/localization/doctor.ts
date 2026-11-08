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
    takeNextLabel: 'Passer en premier',
    takeNextAria: 'Faire passer {ticket} en premier',
    takeNextAsk: 'Faire passer {ticket} · {name} avant les autres ?',
    takeNextConfirm: 'Faire passer en premier',
    takeNextBack: 'Retour',
    takeNextHint:
      'Cette action est enregistrée dans le journal d’audit avec votre nom et le motif.',
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
    takeNextLabel: 'تقديم',
    takeNextAria: 'تقديم {ticket} على الجميع',
    takeNextAsk: 'تقديم {ticket} · {name} على الآخرين؟',
    takeNextConfirm: 'تقديمه أولًا',
    takeNextBack: 'رجوع',
    takeNextHint: 'تُسجَّل هذه الإجراءات في سجل التدقيق مع اسمك والسبب.',
  },
} as const;
