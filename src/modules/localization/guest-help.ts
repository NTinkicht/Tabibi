/**
 * Shared chrome strings for the guest help pages (TAB-UI-17, #831). The page
 * bodies keep their existing copy; only the back link and the clinic footer
 * are shared here.
 */
export const guestHelpCopy = {
  fr: {
    back: 'Retour à l’aide',
    clinicHelpTitle: 'Besoin d’aide à la clinique ?',
    clinicHelpBody:
      'Adressez-vous à l’accueil de votre clinique ; Tabibi ne remplace pas le personnel.',
  },
  ar: {
    back: 'العودة إلى المساعدة',
    clinicHelpTitle: 'هل تحتاج إلى مساعدة في العيادة؟',
    clinicHelpBody:
      'توجّه إلى مكتب الاستقبال في عيادتك؛ طبيبي لا يحلّ محل موظفي العيادة.',
  },
} as const;
