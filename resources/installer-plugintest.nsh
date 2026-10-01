; This isolated test build supports replacing files in the same installation.
; Keep the general release installer's recovery flow unchanged.
!define MODMIND_FEATURE_TEST_INPLACE_UPGRADE
!include "${__FILEDIR__}\installer.nsh"
