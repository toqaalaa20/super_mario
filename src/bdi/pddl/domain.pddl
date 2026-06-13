(define (domain deliveroo)
  (:requirements :typing :action-costs)
  (:types location parcel)
  (:predicates
    (agent-at ?l - location)
    (parcel-at ?p - parcel ?l - location)
    (carrying ?p - parcel)
    (delivered ?p - parcel)
    (is-delivery ?l - location))
  (:functions
    (distance ?l1 ?l2 - location)
    (total-cost))

  (:action move
    :parameters (?from ?to - location)
    :precondition (agent-at ?from)
    :effect (and
      (not (agent-at ?from))
      (agent-at ?to)
      (increase (total-cost) (distance ?from ?to))))

  (:action pickup
    :parameters (?p - parcel ?l - location)
    :precondition (and (agent-at ?l) (parcel-at ?p ?l))
    :effect (and
      (not (parcel-at ?p ?l))
      (carrying ?p)))

  (:action deliver
    :parameters (?p - parcel ?l - location)
    :precondition (and (agent-at ?l) (carrying ?p) (is-delivery ?l))
    :effect (and
      (not (carrying ?p))
      (delivered ?p))))
