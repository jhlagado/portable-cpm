; Independent transient entry-stack/default-DMA regression. Tests choose
; sequential/random READFN and whether to retain or save the supplied stack.
        ORG     $0100

        LD      (ENTRYSP),SP
        LD      A,(PRIVATE)
        OR      A
        JR      Z,ONSTACK
        LD      SP,PRVTOP
ONSTACK:
        ; 44 bytes of application stack plus CALL and the CCP return word
        ; exactly fill the supplied 48-byte reservation in retained mode.
        LD      B,22
        LD      HL,$1234
PUSHLOOP:
        PUSH    HL
        DJNZ    PUSHLOOP
        LD      DE,$005C
        LD      C,15
        CALL    $0005
        LD      (OPENRES),A
        LD      DE,$005C
        LD      A,(READFN)
        LD      C,A
        CALL    $0005
READEND:
        LD      (READRES),A
        LD      B,22
POPLOOP:
        POP     HL
        DJNZ    POPLOOP
        LD      SP,(ENTRYSP)
RETURN:
        RET

ENTRYSP: DW     0
OPENRES: DB     $FF
READRES: DB     $FF
READFN:  DB     20
PRIVATE: DB     1
         DS     48,0
PRVTOP:
